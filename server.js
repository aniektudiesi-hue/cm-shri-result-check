import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR || __dirname;
const subscribersPath = path.join(dataDir, "subscribers.json");

await loadEnvFile(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 3000);
const targetUrl = "https://www.edudel.nic.in/cmshriapp/home.aspx";
const alertCount = Number(process.env.ALERT_COUNT || 5);
const alertEmailTo = process.env.ALERT_EMAIL_TO || "aniketjha327@gmail.com";
const mailer = createMailer();
const subscribers = await loadSubscribers();

const clients = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/") {
    return serveFile(res, "index.html");
  }

  const filename = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").slice(1);
  return serveFile(res, filename);
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const client = {
    socket,
    targetUrl: "",
    interval: null,
    lastCount: null,
    alertArmed: true
  };

  clients.set(socket, client);
  sendJson(socket, {
    type: "ready",
    url: targetUrl,
    subscribers: getAlertRecipients(),
    message: "Connected. Watching the fixed Edudel URL every second."
  });

  socket.on("data", async (buffer) => {
    const message = readWebSocketMessage(buffer);
    if (!message) return;

    try {
      const data = JSON.parse(message);
      if (data.type === "watch") {
        startWatching(client);
      } else if (data.type === "subscribe") {
        await subscribeEmail(socket, data.email);
      } else if (data.type === "list") {
        sendSubscriberList(socket);
      }
    } catch {
      sendJson(socket, { type: "error", message: "Invalid WebSocket message." });
    }
  });

  socket.on("close", () => cleanupClient(client));
  socket.on("error", () => cleanupClient(client));
});

server.listen(port, () => {
  console.log(`WebSocket paragraph counter running at http://localhost:${port}`);
});

async function loadEnvFile(filePath) {
  try {
    const envText = await fs.readFile(filePath, "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) continue;

      const key = trimmed.slice(0, equalsIndex).trim();
      const rawValue = trimmed.slice(equalsIndex + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional. The UI will show if SMTP is not configured.
  }
}

async function serveFile(res, filename) {
  try {
    const filePath = path.resolve(publicDir, filename);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startWatching(client) {
  if (client.interval) {
    clearInterval(client.interval);
  }

  client.targetUrl = targetUrl;
  client.lastCount = null;
  sendJson(client.socket, {
    type: "watching",
    url: client.targetUrl,
    message: "Checking once per second."
  });

  const checkNow = () => pollTarget(client);
  checkNow();
  client.interval = setInterval(checkNow, 1000);
}

async function pollTarget(client) {
  try {
    const response = await fetch(client.targetUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 paragraph-counter/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}`);
    }

    const html = await response.text();
    const count = countParagraphsInsideModalBody(html);
    const changed = client.lastCount !== count;
    client.lastCount = count;

    const alert = await maybeSendAlert(client, count);

    sendJson(client.socket, {
      type: "count",
      url: client.targetUrl,
      count,
      changed,
      alert,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    sendJson(client.socket, {
      type: "error",
      message: error instanceof Error ? error.message : "Unable to check the target."
    });
  }
}

function createMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(SMTP_SECURE || "true").toLowerCase() === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

async function maybeSendAlert(client, count) {
  if (count !== alertCount) {
    client.alertArmed = true;
    return { sent: false, reason: "count-not-matched" };
  }

  if (!client.alertArmed) {
    return { sent: false, reason: "already-sent-for-this-result" };
  }

  client.alertArmed = false;

  if (!mailer) {
    return { sent: false, reason: "smtp-not-configured" };
  }

  const recipients = getAlertRecipients();
  if (recipients.length === 0) {
    return { sent: false, reason: "no-subscribers" };
  }

  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: recipients,
    subject: "CM SHRI Result Check",
    text: `CM SHRI result may be available now.\n\nCheck Result Now: ${client.targetUrl}`,
    html: resultEmailHtml(client.targetUrl)
  });

  return { sent: true, to: recipients };
}

async function subscribeEmail(socket, rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(socket, {
      type: "subscribed",
      ok: false,
      message: "Please enter a valid email address."
    });
    return;
  }

  subscribers.add(email);
  await saveSubscribers();

  sendJson(socket, {
    type: "subscribed",
    ok: true,
    email,
    total: subscribers.size,
    subscribers: getAlertRecipients(),
    message: "Email saved. You will get an alert when the result is ready."
  });
}

function sendSubscriberList(socket) {
  sendJson(socket, {
    type: "subscribers",
    subscribers: getAlertRecipients()
  });
}

function getAlertRecipients() {
  return Array.from(new Set([alertEmailTo, ...subscribers].filter(Boolean)));
}

async function loadSubscribers() {
  try {
    const json = await fs.readFile(subscribersPath, "utf8");
    const list = JSON.parse(json);
    if (Array.isArray(list)) return new Set(list.map((email) => String(email).toLowerCase()));
  } catch {
    // Missing file is fine. It will be created when the first email is added.
  }

  return new Set();
}

async function saveSubscribers() {
  const list = Array.from(subscribers).sort();
  await fs.mkdir(path.dirname(subscribersPath), { recursive: true });
  await fs.writeFile(subscribersPath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

function resultEmailHtml(url) {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f7fb;padding:28px;font-family:Arial,Helvetica,sans-serif;color:#152033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #d9e1ee;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:30px 30px 10px;">
          <h1 style="margin:0;font-size:28px;line-height:1.2;color:#152033;">CM SHRI Result Check</h1>
          <p style="margin:14px 0 0;font-size:16px;line-height:1.7;color:#5d6b82;">Result page update detected. Click the button below to open the official Edudel page.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 30px 34px;">
          <a href="${url}" style="display:inline-block;background:#1d7f68;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 20px;border-radius:8px;">Check Result Now</a>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#7a8699;">Official site: <a href="${url}" style="color:#1d7f68;">${url}</a></p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function countParagraphsInsideModalBody(html) {
  let total = 0;
  const divStartPattern = /<div\b[^>]*class\s*=\s*(["'])[^"']*\bmodal-body\b[^"']*\1[^>]*>/gi;
  let match;

  while ((match = divStartPattern.exec(html))) {
    const contentStart = divStartPattern.lastIndex;
    const contentEnd = findMatchingDivEnd(html, contentStart);
    const modalBodyHtml = html.slice(contentStart, contentEnd);
    total += (modalBodyHtml.match(/<p\b[^>]*>/gi) || []).length;
    divStartPattern.lastIndex = contentEnd;
  }

  return total;
}

function findMatchingDivEnd(html, startIndex) {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = startIndex;
  let depth = 1;
  let match;

  while ((match = tagPattern.exec(html))) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }

  return html.length;
}

function sendJson(socket, payload) {
  if (socket.destroyed) return;
  const json = JSON.stringify(payload);
  const body = Buffer.from(json);
  const header = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.concat([Buffer.from([0x81, 126]), uint16Buffer(body.length)]);

  socket.write(Buffer.concat([header, body]));
}

function uint16Buffer(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function readWebSocketMessage(buffer) {
  const firstByte = buffer[0];
  const opCode = firstByte & 0x0f;
  if (opCode === 0x8) return null;

  const secondByte = buffer[1];
  const isMasked = (secondByte & 0x80) === 0x80;
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(bigLength);
    offset += 8;
  }

  if (!isMasked) return buffer.subarray(offset, offset + length).toString("utf8");

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = buffer.subarray(offset, offset + length);
  const decoded = Buffer.alloc(payload.length);

  for (let index = 0; index < payload.length; index += 1) {
    decoded[index] = payload[index] ^ mask[index % 4];
  }

  return decoded.toString("utf8");
}

function cleanupClient(client) {
  if (client.interval) clearInterval(client.interval);
  clients.delete(client.socket);
}
