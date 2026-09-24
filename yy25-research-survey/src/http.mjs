import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  buildCookie,
  cleanText,
  dailyRateKey,
  hmacBase64Url,
  hmacHex,
  hostWithoutPort,
  isAllowedHost,
  isLoopbackIp,
  isSecureRequest,
  originIsAllowed,
  parseCookies,
  parseJsonBody,
  randomToken,
  requestClientIp,
  safeEqualText,
  sendError,
  sendJson,
  securityHeaders,
  sha256,
} from "./security.mjs";
import { campaignIsAvailable } from "./config.mjs";

const ACCESS_COOKIE = "yy25_access";
const OWNER_COOKIE = "yy25_owner";
const CSRF_COOKIE = "yy25_csrf";
const ACCESS_MAX_AGE_SECONDS = 8 * 60 * 60;
const OWNER_MAX_AGE_SECONDS = 8 * 60 * 60;
const PUBLIC_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/vendor/lucide.min.js", ["vendor/lucide.min.js", "text/javascript; charset=utf-8"]],
  ["/assets/five-elements-wheel.png", ["assets/five-elements-wheel.png", "image/png"]],
]);
const ADMIN_ASSETS = new Map([
  ["/", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/admin.css", ["admin.css", "text/css; charset=utf-8"]],
]);

function nowIso() {
  return new Date().toISOString();
}

function publicHeaders(request, runtime) {
  const secure = isSecureRequest(request, {
    trustLoopbackProxy: Boolean(runtime.config.public.trustLoopbackProxy),
  });
  return {
    secure,
    hsts: secure && !runtime.config.public.allowInsecureLocal,
  };
}

function serveFile(response, root, relative, contentType, options) {
  const rootPath = path.resolve(root);
  const file = path.resolve(rootPath, relative);
  if (file !== rootPath && !file.startsWith(`${rootPath}${path.sep}`)) {
    sendError(response, 400, "invalid_path", "请求路径不合法", options);
    return;
  }
  if (!fs.existsSync(file)) {
    sendError(response, 404, "not_found", "页面不存在", options);
    return;
  }
  const content = fs.readFileSync(file);
  response.writeHead(200, {
    ...securityHeaders(options),
    "Content-Type": contentType,
    "Content-Length": content.length,
  });
  if (options.head) response.end();
  else response.end(content);
}

function validJsonRequest(request, response, options) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/json") return true;
  sendError(response, 415, "unsupported_media_type", "请求必须使用 application/json", options);
  return false;
}

function accessPayload(campaignId, expiresAt) {
  return `${expiresAt}.${campaignId}`;
}

function createAccessValue(campaignId, expiresAt, cookieSecret) {
  const payload = accessPayload(campaignId, expiresAt);
  return `${payload}.${hmacBase64Url(payload, cookieSecret)}`;
}

function accessFromCookies(cookies, runtime) {
  const parts = String(cookies[ACCESS_COOKIE] || "").split(".");
  if (parts.length !== 3) return null;
  const [expiresRaw, campaignId, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const payload = accessPayload(campaignId, expiresRaw);
  if (!safeEqualText(signature, hmacBase64Url(payload, runtime.secrets.cookieSecret))) return null;
  const campaign = runtime.config.campaigns.find((entry) => entry.id === campaignId);
  if (!campaign || !campaignIsAvailable(campaign) || !cookies[OWNER_COOKIE] || !cookies[CSRF_COOKIE]) return null;
  return { cookies, campaign };
}

function ownerHash(cookies, runtime) {
  return cookies[OWNER_COOKIE] ? hmacHex(cookies[OWNER_COOKIE], runtime.secrets.cookieSecret) : "";
}

function hasCsrf(request, cookies) {
  const received = String(request.headers["x-yy25-csrf"] || "");
  return Boolean(received && cookies[CSRF_COOKIE] && safeEqualText(received, cookies[CSRF_COOKIE]));
}

function rateLimit(store, request, runtime, action, limit, windowMs) {
  const ip = requestClientIp(request, { trustLoopbackProxy: Boolean(runtime.config.public.trustLoopbackProxy) });
  return store.consumeRate({
    keyHash: dailyRateKey(ip, runtime.secrets.metadataSecret),
    action,
    limit,
    windowMs,
    retentionHours: runtime.config.privacy.rateMetadataRetentionHours,
  });
}

function campaignByInviteCode(runtime, code) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(code)) return null;
  const hash = sha256(code);
  return runtime.config.campaigns.find((campaign) => safeEqualText(campaign.inviteCodeHash, hash)) || null;
}

function sendPublicNotFound(response, options) {
  sendError(response, 404, "not_found", "页面不存在", options);
}

function redirectToHttps(response, request, runtime, options) {
  const incoming = new URL(request.url || "/", runtime.config.public.origin);
  const target = new URL(runtime.config.public.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  response.writeHead(308, {
    ...securityHeaders(options),
    Location: target.toString(),
  });
  response.end();
}

function rejectPublicAdminPath(url, response, options) {
  if (url.pathname === "/healthz" || url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/admin/")) {
    sendPublicNotFound(response, options);
    return true;
  }
  return false;
}

function sessionRecordForRequest(store, sessionId, access, runtime) {
  const record = store.getRecord(sessionId);
  if (!record || record.row.campaign_id !== access.campaign.id || record.row.owner_hash !== ownerHash(access.cookies, runtime)) return null;
  return record;
}

function publicState(store, assessment, record, campaign) {
  return assessment.publicState(record.row, record.state, record.result, campaign);
}

async function handlePublic(request, response, context) {
  const { runtime, store, assessment, publicDir } = context;
  const options = publicHeaders(request, runtime);
  const method = request.method || "GET";
  const hostAllowed = isAllowedHost(request, runtime.config.public.allowedHosts, runtime.config.public.allowInsecureLocal);
  if (!hostAllowed) {
    sendError(response, 421, "misdirected_request", "域名不受支持", options);
    return;
  }
  const url = new URL(request.url || "/", runtime.config.public.origin);
  if (url.pathname.length > 2048) {
    sendError(response, 414, "uri_too_long", "请求地址过长", options);
    return;
  }
  if (!options.secure && !runtime.config.public.allowInsecureLocal) {
    redirectToHttps(response, request, runtime, options);
    return;
  }
  if (rejectPublicAdminPath(url, response, options)) return;
  if (method === "OPTIONS") {
    response.writeHead(204, securityHeaders(options));
    response.end();
    return;
  }
  if (url.pathname === "/robots.txt") {
    response.writeHead(200, { ...securityHeaders(options), "Content-Type": "text/plain; charset=utf-8" });
    response.end("User-agent: *\nDisallow: /\n");
    return;
  }
  if (url.pathname.startsWith("/q/")) {
    if (method !== "GET") {
      sendPublicNotFound(response, options);
      return;
    }
    const quota = rateLimit(store, request, runtime, "entry", 10, 60_000);
    if (!quota.ok) {
      sendError(response, 429, "rate_limited", "访问过于频繁", { ...options, headers: { "Retry-After": quota.retryAfter } });
      return;
    }
    const code = url.pathname.slice(3).replace(/\/$/, "");
    const campaign = campaignByInviteCode(runtime, code);
    if (!campaign || !campaignIsAvailable(campaign)) {
      sendPublicNotFound(response, options);
      return;
    }
    const existing = parseCookies(request.headers.cookie);
    const owner = existing[OWNER_COOKIE] || randomToken(24);
    const csrf = existing[CSRF_COOKIE] || randomToken(24);
    const campaignExpiry = Date.parse(campaign.expiresAt);
    const expiresAt = Math.min(Date.now() + ACCESS_MAX_AGE_SECONDS * 1000, campaignExpiry);
    const headers = {
      Location: "/",
      "Set-Cookie": [
        buildCookie(ACCESS_COOKIE, createAccessValue(campaign.id, expiresAt, runtime.secrets.cookieSecret), { maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)), secure: options.secure }),
        buildCookie(OWNER_COOKIE, owner, { maxAge: OWNER_MAX_AGE_SECONDS, secure: options.secure }),
        buildCookie(CSRF_COOKIE, csrf, { maxAge: OWNER_MAX_AGE_SECONDS, secure: options.secure, httpOnly: false }),
      ],
    };
    response.writeHead(302, { ...securityHeaders(options), ...headers });
    response.end();
    return;
  }

  const cookies = parseCookies(request.headers.cookie);
  const access = accessFromCookies(cookies, runtime);
  if (!access) {
    sendPublicNotFound(response, options);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, {
        csrfToken: access.cookies[CSRF_COOKIE],
        campaign: {
          id: access.campaign.id,
          name: access.campaign.name,
          studyPhase: access.campaign.studyPhase,
          expiresAt: access.campaign.expiresAt,
        },
        consent: {
          version: runtime.config.privacy.consentVersion,
          ageMinimum: runtime.config.privacy.ageMinimum,
          retentionDays: runtime.config.privacy.retentionDays,
          contact: runtime.config.privacy.contact,
        },
        instrument: {
          version: assessment.instrumentVersion,
          sourceManifest: assessment.manifest,
          routeVersion: assessment.adaptive.ROUTE_VERSION,
          codebookVersion: assessment.codebook.version,
          scoringVersion: assessment.adaptive.SCORING_VERSION,
        },
      }, options);
      return;
    }

    const csrfRequired = method !== "GET" && method !== "HEAD";
    if (csrfRequired && (!originIsAllowed(request, runtime.config.public.origin, runtime.config.public.allowInsecureLocal) || !hasCsrf(request, access.cookies))) {
      sendError(response, 403, "csrf_or_origin", "请求来源未通过校验", options);
      return;
    }

    const currentMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/current$/i);
    if (method === "GET" && currentMatch) {
      const record = sessionRecordForRequest(store, currentMatch[1], access, runtime);
      if (!record) {
        sendPublicNotFound(response, options);
        return;
      }
      sendJson(response, 200, publicState(store, assessment, record, access.campaign), options);
      return;
    }

    if (method === "POST" && url.pathname === "/api/sessions") {
      if (!validJsonRequest(request, response, options)) return;
      const quota = rateLimit(store, request, runtime, "session_create", 20, 60_000);
      if (!quota.ok) {
        sendError(response, 429, "rate_limited", "创建会话过于频繁", { ...options, headers: { "Retry-After": quota.retryAfter } });
        return;
      }
      let body;
      try { body = await parseJsonBody(request); } catch (error) {
        sendError(response, error.statusCode || 400, "invalid_request", error.message, options);
        return;
      }
      if (body?.ageConfirmed !== true || body?.consent !== true || body?.consentVersion !== runtime.config.privacy.consentVersion) {
        sendError(response, 422, "consent_required", "请确认已满 18 岁并同意数据处理说明", options);
        return;
      }
      const created = store.createConsentedSession({
        campaign: access.campaign,
        ownerHash: ownerHash(access.cookies, runtime),
        consentVersion: body.consentVersion,
      });
      if (created.error === "campaign_limit") {
        sendError(response, 429, "campaign_limit", "本次活动已达到会话上限", options);
        return;
      }
      sendJson(response, 201, publicState(store, assessment, created, access.campaign), options);
      return;
    }

    const answerMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/answer$/i);
    if (method === "POST" && answerMatch) {
      if (!validJsonRequest(request, response, options)) return;
      const quota = rateLimit(store, request, runtime, "answer", 80, 60_000);
      if (!quota.ok) {
        sendError(response, 429, "rate_limited", "提交过于频繁", { ...options, headers: { "Retry-After": quota.retryAfter } });
        return;
      }
      let body;
      try { body = await parseJsonBody(request); } catch (error) {
        sendError(response, error.statusCode || 400, "invalid_request", error.message, options);
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendError(response, 422, "invalid_body", "请求内容不合法", options);
        return;
      }
      const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : -1;
      const durationMs = Number.isInteger(body.durationMs) ? Math.max(0, Math.min(body.durationMs, 15 * 60 * 1000)) : 0;
      const updated = store.answerSession({
        id: answerMatch[1],
        ownerHash: ownerHash(access.cookies, runtime),
        expectedRevision,
        questionId: cleanText(body.questionId, 10),
        answer: body.answer,
        durationMs,
      });
      if (updated.error === "not_found") {
        sendPublicNotFound(response, options);
        return;
      }
      if (updated.error === "question_order") {
        sendError(response, 409, "question_order", "请按当前题目顺序作答", options);
        return;
      }
      if (updated.error === "campaign_limit") {
        sendError(response, 429, "campaign_limit", "本次活动已达到答题上限", options);
        return;
      }
      if (updated.error) {
        sendError(response, 422, "invalid_answer", "答案不合法", options);
        return;
      }
      sendJson(response, 200, publicState(store, assessment, updated.record, access.campaign), {
        ...options,
        headers: { "X-YY25-Ack": String(updated.record.row.revision) },
      });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/i);
    if (method === "DELETE" && deleteMatch) {
      const deleted = store.deleteOwnedSession({ id: deleteMatch[1], ownerHash: ownerHash(access.cookies, runtime) });
      if (!deleted) {
        sendPublicNotFound(response, options);
        return;
      }
      sendJson(response, 200, { deleted: true }, options);
      return;
    }

    sendPublicNotFound(response, options);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendPublicNotFound(response, options);
    return;
  }
  const asset = PUBLIC_ASSETS.get(url.pathname);
  if (!asset) {
    sendPublicNotFound(response, options);
    return;
  }
  serveFile(response, publicDir, asset[0], asset[1], { ...options, head: method === "HEAD" });
}

function requireAdmin(request, response, runtime) {
  const auth = String(request.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqualText(sha256(token), sha256(runtime.secrets.adminToken))) {
    sendError(response, 401, "unauthorized", "管理令牌不正确");
    return false;
  }
  return true;
}

function localAdminRequest(request) {
  if (!isLoopbackIp(request.socket?.remoteAddress)) return false;
  const host = hostWithoutPort(request.headers.host);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function selectedCampaign(store, url) {
  const requested = cleanText(url.searchParams.get("campaign") || "", 64);
  if (requested && store.campaign(requested)) return requested;
  const active = store.listCampaigns().find((campaign) => campaign.status === "active");
  return active?.id || store.listCampaigns()[0]?.id || "";
}

async function handleAdmin(request, response, context) {
  const { runtime, store, adminDir } = context;
  const method = request.method || "GET";
  if (!localAdminRequest(request)) {
    sendError(response, 404, "not_found", "页面不存在");
    return;
  }
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname.length > 2048) {
    sendError(response, 414, "uri_too_long", "请求地址过长");
    return;
  }
  if (url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, service: "yy25-admin", time: nowIso() });
    return;
  }
  if (url.pathname.startsWith("/api/admin/")) {
    if (!requireAdmin(request, response, runtime)) return;
    const quota = store.consumeRate({
      keyHash: hmacHex("local-admin", runtime.secrets.metadataSecret),
      action: "admin",
      limit: 60,
      windowMs: 60_000,
      retentionHours: runtime.config.privacy.rateMetadataRetentionHours,
    });
    if (!quota.ok) {
      sendError(response, 429, "rate_limited", "管理请求过于频繁", { headers: { "Retry-After": quota.retryAfter } });
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/campaigns") {
      sendJson(response, 200, { campaigns: store.listCampaigns() });
      return;
    }
    const campaignId = selectedCampaign(store, url);
    if (!campaignId) {
      sendError(response, 404, "campaign_not_found", "活动不存在");
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/summary") {
      sendJson(response, 200, store.campaignSummary(campaignId));
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/export.csv") {
      const csv = store.exportCsv(campaignId);
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="yy25-${campaignId}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Content-Length": Buffer.byteLength(csv),
      });
      response.end(csv);
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/cleanup") {
      sendJson(response, 200, store.cleanup());
      return;
    }
    sendError(response, 404, "not_found", "接口不存在");
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendError(response, 404, "not_found", "页面不存在");
    return;
  }
  const asset = ADMIN_ASSETS.get(url.pathname);
  if (!asset) {
    sendError(response, 404, "not_found", "页面不存在");
    return;
  }
  serveFile(response, adminDir, asset[0], asset[1], { head: method === "HEAD" });
}

function makeServer(handler, logger) {
  const server = http.createServer({ maxHeaderSize: 8 * 1024, requireHostHeader: true }, (request, response) => {
    response.setTimeout(15_000, () => response.destroy());
    handler(request, response).catch((error) => {
      if (!response.headersSent) sendError(response, 500, "server_error", "服务暂时无法处理请求");
      else response.destroy();
      logger?.error?.(`[yy25] request failed: ${error?.name || "Error"}`);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  return server;
}

export function createServers({ runtime, store, assessment, publicDir, adminDir, logger = console }) {
  const context = { runtime, store, assessment, publicDir, adminDir };
  return {
    publicServer: makeServer((request, response) => handlePublic(request, response, context), logger),
    adminServer: makeServer((request, response) => handleAdmin(request, response, context), logger),
  };
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

