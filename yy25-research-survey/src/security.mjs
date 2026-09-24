import crypto from "node:crypto";
import net from "node:net";

export const BODY_LIMIT = 64 * 1024;

export function isoNow(clock = Date) {
  return new clock().toISOString();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) || ArrayBuffer.isView(value) ? value : String(value);
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacHex(value, secret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

export function hmacBase64Url(value, secret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("base64url");
}

export function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!/^[A-Za-z0-9_\-]{1,80}$/.test(name)) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Invalid cookie encodings are treated as absent rather than server errors.
    }
  }
  return cookies;
}

export function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Number(options.maxAge ?? 0))}`,
    "Path=/",
    `SameSite=${options.sameSite || "Lax"}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name, secure) {
  return buildCookie(name, "", { maxAge: 0, secure, sameSite: "Lax" });
}

export function normalizeIp(value) {
  const raw = String(value || "").trim().replace(/^::ffff:/i, "");
  return net.isIP(raw) ? raw : "unknown";
}

export function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  return ip === "127.0.0.1" || ip === "::1";
}

export function requestClientIp(request, { trustLoopbackProxy = false } = {}) {
  const peer = normalizeIp(request.socket?.remoteAddress);
  if (!trustLoopbackProxy || !isLoopbackIp(peer)) return peer;
  const cloudflareIp = normalizeIp(request.headers["cf-connecting-ip"]);
  return cloudflareIp === "unknown" ? peer : cloudflareIp;
}

export function dailyRateKey(ip, metadataSecret, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return hmacHex(`${day}|${normalizeIp(ip)}`, metadataSecret);
}

export function hostWithoutPort(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(1, end) : "";
  }
  return host.replace(/:\d+$/, "");
}

export function isAllowedHost(request, allowedHosts, allowLocalhost = false) {
  const host = hostWithoutPort(request.headers.host);
  if (allowedHosts.includes(host)) return true;
  return Boolean(allowLocalhost && (host === "127.0.0.1" || host === "localhost" || host === "::1"));
}

export function isSecureRequest(request, settings) {
  if (request.socket?.encrypted) return true;
  if (!settings.trustLoopbackProxy || !isLoopbackIp(request.socket?.remoteAddress)) return false;
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim().toLowerCase();
  const cfVisitor = String(request.headers["cf-visitor"] || "");
  return forwardedProto === "https" || /"scheme"\s*:\s*"https"/i.test(cfVisitor);
}

export function originIsAllowed(request, origin, allowInsecureLocal = false) {
  const supplied = String(request.headers.origin || "");
  if (supplied === origin) return true;
  if (!allowInsecureLocal || !supplied) return false;
  try {
    const parsed = new URL(supplied);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function securityHeaders({ secure = false, hsts = false } = {}) {
  const headers = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
    "Cache-Control": "no-store",
  };
  if (secure && hsts) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

export function sendJson(response, status, body, options = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders(options),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    ...(options.headers || {}),
  });
  response.end(text);
}

export function sendError(response, status, code, message, options = {}) {
  sendJson(response, status, { error: code, message }, options);
}

export function sendText(response, status, body, contentType, options = {}) {
  const text = String(body);
  response.writeHead(status, {
    ...securityHeaders(options),
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    ...(options.headers || {}),
  });
  response.end(text);
}

export function parseJsonBody(request, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

export function cleanText(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, max);
}

export function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

