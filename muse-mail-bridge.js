/*
 * muse-mail-bridge (Cloudflare Workers version) — intermediate adapter for
 * the you@your-domain.example mailbox.
 *
 * Why this exists: the mailbox password cannot be used from Muse's
 * credential vault directly, because the vault's surrogate swap only works
 * inside HTTP requests, not inside IMAP/SMTP logins. This Worker is the
 * middle layer that makes the stored-credential route work anyway:
 *
 *   mail_muse.py --HTTPS + Bearer (surrogate, swapped to the real token)-->
 *   this Worker --IMAP/SMTP over TLS sockets, mailbox password from a
 *   Worker secret--> the Sakura mail server.
 *
 * The vault therefore holds only this bridge's API token. The mailbox
 * password itself lives solely as a Cloudflare Worker secret (MAIL_PASS),
 * entered by the account owner in the Cloudflare dashboard. Neither secret
 * ever passes through the chat.
 *
 * Secrets / vars to set on the Worker:
 *   BRIDGE_TOKEN  (secret) long random string; the same value goes into
 *                 Muse's connector credential slot for custom.sakura-mail.
 *   MAIL_PASS     (secret) the mailbox password.
 *   MAIL_USER     (plain, optional) defaults to you@your-domain.example.
 *   IMAP_HOST / SMTP_HOST (plain, optional) default your-initial-domain.sakura.ne.jp.
 *
 * Protocol: POST a JSON body {"action": "ping|check|list|read|send", ...}
 * with header "Authorization: Bearer <token>" (or "X-Bridge-Token: <token>").
 * Response is JSON shaped like the mail_muse.py helper's own output.
 */

import { connect } from "cloudflare:sockets";

const DEFAULT_MAIL_USER = "you@your-domain.example";
const DEFAULT_HOST = "your-initial-domain.sakura.ne.jp";
const CRLF = new Uint8Array([13, 10]);
const encoder = new TextEncoder();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ----------------------------------------------------------- byte helpers */

function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/* Byte-faithful latin1 decode: string indices stay aligned with byte
 * offsets, which the IMAP literal parsing relies on. */
function latin1Decode(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function latin1Encode(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function b64encode(bytes) {
  return btoa(latin1Decode(bytes));
}

function b64decode(text) {
  return latin1Encode(atob(text.replace(/\s+/g, "")));
}

function decodeCharset(bytes, charset) {
  const cs = (charset || "utf-8").toLowerCase().trim();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* -------------------------------------------------------------- socket IO */

function findCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

class SocketIO {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = new Uint8Array(0);
  }

  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("connection closed by server");
    this.buf = concatBytes(this.buf, value);
  }

  /* One physical line, bytes without the trailing CRLF. */
  async readLineBytes() {
    for (;;) {
      const idx = findCRLF(this.buf);
      if (idx >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return line;
      }
      await this.fill();
    }
  }

  async readExact(count) {
    while (this.buf.length < count) await this.fill();
    const out = this.buf.slice(0, count);
    this.buf = this.buf.slice(count);
    return out;
  }

  /*
   * One logical IMAP line: physical lines plus any {n} literals inlined,
   * byte-faithful (CRLFs preserved), so literal offsets stay findable.
   */
  async readLogicalLine() {
    const parts = [];
    let line = await this.readLineBytes();
    for (;;) {
      parts.push(line, CRLF);
      const tail = new TextDecoder("utf-8").decode(line);
      const m = /\{(\d+)\}$/.exec(tail);
      if (!m) break;
      parts.push(await this.readExact(parseInt(m[1], 10)));
      line = await this.readLineBytes();
    }
    return concatBytes(...parts);
  }

  async write(data) {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    await this.writer.write(bytes);
  }

  async close() {
    try {
      await this.writer.close();
    } catch {}
    try {
      this.socket.close();
    } catch {}
  }
}

/* ------------------------------------------------------------ IMAP client */

function imapQuote(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

class ImapClient {
  constructor(io) {
    this.io = io;
    this.tagSeq = 0;
  }

  static async connect(host, user, pass) {
    const socket = connect({ hostname: host, port: 993 }, { secureTransport: "on" });
    const io = new SocketIO(socket);
    const client = new ImapClient(io);
    const greeting = latin1Decode(await io.readLogicalLine());
    if (!greeting.startsWith("* OK")) throw new Error("imap greeting failed");
    await client.command("LOGIN " + imapQuote(user) + " " + imapQuote(pass));
    return client;
  }

  /* Run a tagged command; returns the untagged response chunks (bytes). */
  async command(command) {
    const tag = "A" + ++this.tagSeq;
    await this.io.write(tag + " " + command + "\r\n");
    const untagged = [];
    for (;;) {
      const line = await this.io.readLogicalLine();
      const text = latin1Decode(line);
      if (text.startsWith(tag + " ")) {
        if (!new RegExp("^" + tag + " OK", "i").test(text)) {
          throw new Error("imap command failed: " + text.trim().slice(0, 200));
        }
        return untagged;
      }
      untagged.push(line);
    }
  }

  async listFolders() {
    const untagged = await this.command('LIST "" "*"');
    const folders = [];
    for (const chunk of untagged) {
      const line = latin1Decode(chunk).trim();
      const m = /^\* LIST \([^)]*\) (?:"(?:[^"\\]|\\.)*"|\S+) (.+)$/.exec(line);
      if (m) {
        let name = m[1].trim();
        if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
          name = name.slice(1, -1).replace(/\\(.)/g, "$1");
        }
        folders.push(name);
      }
    }
    return folders;
  }

  async examineInbox() {
    await this.command("EXAMINE INBOX");
  }

  async search(criteria) {
    const untagged = await this.command("SEARCH " + criteria);
    for (const chunk of untagged) {
      const m = /^\* SEARCH((?: \d+)*)/.exec(latin1Decode(chunk).trim());
      if (m) {
        const nums = m[1].trim();
        return nums === "" ? [] : nums.split(" ").map((s) => parseInt(s, 10));
      }
    }
    return [];
  }

  /* FETCH; returns one raw chunk (bytes) per message. */
  async fetch(sequenceSet, items, byUid = false) {
    const untagged = await this.command(
      (byUid ? "UID FETCH " : "FETCH ") + sequenceSet + " (" + items + ")"
    );
    return untagged.filter((chunk) => /^\* \d+ FETCH /.test(latin1Decode(chunk)));
  }

  async close() {
    try {
      await this.command("LOGOUT");
    } catch {}
    await this.io.close();
  }
}

/* --------------------------------------------------------- header helpers */

function unfold(raw) {
  return raw.replace(/\r?\n[ \t]+/g, " ").trim();
}

/* Decode one RFC 2047 encoded-word payload's bytes with its charset. */
function decodeEncodedWord(charset, encoding, text) {
  let bytes;
  if (encoding.toUpperCase() === "B") {
    try {
      bytes = b64decode(text);
    } catch {
      return text;
    }
  } else {
    const spaced = text.replace(/_/g, " ");
    const out = [];
    for (let i = 0; i < spaced.length; i++) {
      if (spaced[i] === "=" && i + 2 < spaced.length + 0 && /^[0-9A-Fa-f]{2}$/.test(spaced.slice(i + 1, i + 3))) {
        out.push(parseInt(spaced.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(spaced.charCodeAt(i) & 0xff);
      }
    }
    bytes = new Uint8Array(out);
  }
  return decodeCharset(bytes, charset);
}

function decodeHeader(raw) {
  const value = unfold(raw);
  // Decode encoded words; whitespace between adjacent encoded words drops.
  return value.replace(
    /(=\?[^?]+\?[BQ]\?[^?]*\?=)(\s+)(?==\?)/gi,
    "$1"
  ).replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (whole, charset, encoding, text) =>
    decodeEncodedWord(charset, encoding, text)
  );
}

/* First occurrence of a header in a raw header block (already a string). */
function headerValue(headerBlock, name) {
  const text = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp("^" + name + ":[ \\t]*(.*)$", "mi").exec(text);
  return m ? m[1].trim() : "";
}

/* ------------------------------------------------------- message handling */

/* Extract the first text/plain body from a raw RFC822 message (bytes). */
function extractPlainBody(raw) {
  let splitAt = indexOfBytes(raw, new Uint8Array([13, 10, 13, 10]));
  let sepLen = 4;
  if (splitAt < 0) {
    splitAt = indexOfBytes(raw, new Uint8Array([10, 10]));
    sepLen = 2;
  }
  const headerBytes = splitAt < 0 ? raw : raw.slice(0, splitAt);
  const body = splitAt < 0 ? new Uint8Array(0) : raw.slice(splitAt + sepLen);
  const headers = latin1Decode(headerBytes);

  const contentType = headerValue(headers, "Content-Type");
  let charset = "";
  const cm = /charset="?([^";\s]+)"?/i.exec(contentType);
  if (cm) charset = cm[1];

  if (/^multipart\//i.test(contentType)) {
    const bm = /boundary="?([^";]+)"?/i.exec(contentType);
    if (!bm) return "";
    const boundary = bm[1];
    const bodyText = latin1Decode(body);
    const parts = bodyText.split("--" + boundary);
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, "").replace(/\r?\n--$/, "");
      if (trimmed.trim() === "" || trimmed.trim() === "--") continue;
      const found = extractPlainBody(latin1Encode(trimmed));
      if (found !== "") return found;
    }
    return "";
  }

  if (contentType !== "" && !/^text\/plain/i.test(contentType)) return "";

  const encoding = headerValue(headers, "Content-Transfer-Encoding").toLowerCase();
  let decoded = body;
  if (encoding === "base64") {
    try {
      decoded = b64decode(latin1Decode(body));
    } catch {
      decoded = new Uint8Array(0);
    }
  } else if (encoding === "quoted-printable") {
    decoded = latin1Encode(
      latin1Decode(body)
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (whole, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        )
    );
  }
  return decodeCharset(decoded, charset || "utf-8");
}

/* ------------------------------------------------------------ SMTP sender */

async function smtpReadReply(io) {
  let code = 0;
  let last = "";
  for (;;) {
    const line = new TextDecoder("utf-8").decode(await io.readLineBytes());
    last = line.trim();
    const m = /^(\d{3}) /.exec(line);
    if (m) {
      code = parseInt(m[1], 10);
      break;
    }
    if (/^\d{3}$/.test(line.trim())) {
      code = parseInt(line.trim(), 10);
      break;
    }
    if (!/^\d{3}-/.test(line)) {
      code = parseInt(line.slice(0, 3), 10) || 0;
      break;
    }
  }
  return [code, last];
}

async function smtpExpect(io, want, what) {
  const [code, line] = await smtpReadReply(io);
  if (code !== want) throw new Error("smtp " + what + " failed: " + line);
}

async function smtpSend(host, user, pass, from, to, subject, body) {
  const socket = connect({ hostname: host, port: 465 }, { secureTransport: "on" });
  const io = new SocketIO(socket);
  try {
    await smtpExpect(io, 220, "greeting");
    await io.write("EHLO " + host + "\r\n");
    await smtpExpect(io, 250, "EHLO");
    const auth = concatBytes(
      new Uint8Array([0]),
      encoder.encode(user),
      new Uint8Array([0]),
      encoder.encode(pass)
    );
    await io.write("AUTH PLAIN " + b64encode(auth) + "\r\n");
    await smtpExpect(io, 235, "AUTH");
    await io.write("MAIL FROM:<" + from + ">\r\n");
    await smtpExpect(io, 250, "MAIL FROM");
    await io.write("RCPT TO:<" + to + ">\r\n");
    await smtpExpect(io, 250, "RCPT TO");
    await io.write("DATA\r\n");
    await smtpExpect(io, 354, "DATA");

    const encodedSubject =
      "=?UTF-8?B?" + b64encode(encoder.encode(subject)) + "?=";
    const headers = [
      "From: " + from,
      "To: " + to,
      "Subject: " + encodedSubject,
      "Date: " + new Date().toUTCString(),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ].join("\r\n");
    const bodyB64 = b64encode(encoder.encode(body));
    const bodyLines = bodyB64.replace(/(.{76})/g, "$1\r\n");
    await io.write(headers + "\r\n\r\n" + bodyLines + "\r\n.\r\n");
    await smtpExpect(io, 250, "message");
    await io.write("QUIT\r\n");
  } finally {
    await io.close();
  }
}

/* ---------------------------------------------------------------- handler */

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) });
    }
  },
};

async function handle(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const authHeader = request.headers.get("Authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = (bearer ? bearer[1].trim() : "") ||
    (request.headers.get("X-Bridge-Token") || "").trim();
  if (!env.BRIDGE_TOKEN || token !== env.BRIDGE_TOKEN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const input = await request.json().catch(() => null);
  if (!input || typeof input.action !== "string") {
    return json({ ok: false, error: "bad request: JSON body with an action is required" }, 400);
  }
  const action = input.action;

  if (action === "ping") {
    return json({ ok: true, bridge: "muse-mail-bridge-worker", version: 1 });
  }

  const mailUser = env.MAIL_USER || DEFAULT_MAIL_USER;
  const mailPass = env.MAIL_PASS;
  if (!mailPass) return json({ ok: false, error: "MAIL_PASS secret is not set" }, 500);
  const imapHost = env.IMAP_HOST || DEFAULT_HOST;
  const smtpHost = env.SMTP_HOST || DEFAULT_HOST;

  switch (action) {
    case "check": {
      const imap = await ImapClient.connect(imapHost, mailUser, mailPass);
      try {
        const folders = await imap.listFolders();
        await imap.examineInbox();
        const total = (await imap.search("ALL")).length;
        const unseen = (await imap.search("UNSEEN")).length;
        return json({
          ok: true,
          user: mailUser,
          folders,
          inbox_total: total,
          inbox_unseen: unseen,
        });
      } finally {
        await imap.close();
      }
    }

    case "list": {
      const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
      const imap = await ImapClient.connect(imapHost, mailUser, mailPass);
      try {
        await imap.examineInbox();
        const all = await imap.search("ALL");
        const picked = all.slice(-limit);
        const messages = [];
        if (picked.length > 0) {
          const chunks = await imap.fetch(
            picked.join(","),
            "UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]"
          );
          for (const chunk of chunks) {
            const text = latin1Decode(chunk);
            const numMatch = /^\* (\d+) FETCH/.exec(text);
            const uidMatch = /\bUID (\d+)/.exec(text);
            messages.push({
              num: numMatch ? numMatch[1] : null,
              uid: uidMatch ? uidMatch[1] : null,
              date: decodeHeader(headerValue(text, "Date")),
              from: decodeHeader(headerValue(text, "From")),
              subject: decodeHeader(headerValue(text, "Subject")),
            });
          }
          messages.reverse();
        }
        return json({ ok: true, messages });
      } finally {
        await imap.close();
      }
    }

    case "read": {
      const uid = String(input.uid ?? "");
      if (!/^\d+$/.test(uid)) {
        return json({ ok: false, error: "bad request: numeric uid is required" }, 400);
      }
      const imap = await ImapClient.connect(imapHost, mailUser, mailPass);
      try {
        await imap.examineInbox();
        const chunks = await imap.fetch(uid, "RFC822", true);
        if (chunks.length === 0) {
          return json({ ok: false, error: "uid " + uid + " not found" });
        }
        const chunk = chunks[0];
        const text = latin1Decode(chunk);
        const litMatch = /\{(\d+)\}\r\n/.exec(text);
        if (!litMatch) return json({ ok: false, error: "could not parse fetched message" });
        const start = litMatch.index + litMatch[0].length;
        const raw = chunk.slice(start, start + parseInt(litMatch[1], 10));
        let splitAt = indexOfBytes(raw, new Uint8Array([13, 10, 13, 10]));
        const headerBlock = latin1Decode(splitAt < 0 ? raw : raw.slice(0, splitAt));
        return json({
          ok: true,
          uid,
          date: decodeHeader(headerValue(headerBlock, "Date")),
          from: decodeHeader(headerValue(headerBlock, "From")),
          to: decodeHeader(headerValue(headerBlock, "To")),
          subject: decodeHeader(headerValue(headerBlock, "Subject")),
          body: extractPlainBody(raw),
        });
      } finally {
        await imap.close();
      }
    }

    case "send": {
      const to = String(input.to ?? "");
      const subject = String(input.subject ?? "");
      const body = String(input.body ?? "");
      if (!/^[^@\s]+@[^@\s]+$/.test(to)) {
        return json({ ok: false, error: "bad request: a valid to address is required" }, 400);
      }
      await smtpSend(smtpHost, mailUser, mailPass, mailUser, to, subject, body);
      return json({ ok: true, from: mailUser, to, subject });
    }

    default:
      return json({ ok: false, error: "unknown action: " + action }, 400);
  }
}
