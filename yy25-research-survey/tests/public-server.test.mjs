import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAssessment } from "../src/assessment.mjs";
import { SOURCE_BUNDLE_DIR } from "../src/config.mjs";
import { closeServer, createServers, listen } from "../src/http.mjs";
import { randomToken, sha256 } from "../src/security.mjs";
import { SurveyStore } from "../src/store.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = path.join(projectRoot, "public");
const adminDir = path.join(projectRoot, "admin");

function makeRuntime({ maxStartedSessions = 2000, trustLoopbackProxy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yy25-runtime-"));
  fs.mkdirSync(path.join(directory, "private"), { recursive: true });
  const inviteCode = randomToken(32);
  const config = {
    schemaVersion: 1,
    environment: "test",
    public: {
      origin: "http://127.0.0.1",
      allowedHosts: ["127.0.0.1"],
      publicHost: "127.0.0.1",
      publicPort: 0,
      adminHost: "127.0.0.1",
      adminPort: 0,
      trustLoopbackProxy,
      allowInsecureLocal: true,
    },
    privacy: {
      ageMinimum: 18,
      consentVersion: "test-consent-v1",
      retentionDays: 90,
      unstartedRetentionHours: 24,
      rateMetadataRetentionHours: 24,
      contact: "test-contact",
    },
    campaigns: [{
      id: "test-campaign",
      name: "Test campaign",
      studyPhase: "test",
      status: "active",
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxStartedSessions,
      context: {},
      inviteCodeHash: sha256(inviteCode),
    }],
  };
  const secrets = {
    cookieSecret: randomToken(48),
    metadataSecret: randomToken(48),
    backupSecret: randomToken(48),
    adminToken: randomToken(48),
    inviteCodes: { "test-campaign": inviteCode },
  };
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify(config)}\n`);
  fs.writeFileSync(path.join(directory, "private", "secrets.json"), `${JSON.stringify(secrets)}\n`);
  return { directory, config, secrets, inviteCode };
}

function cookieValue(cookieHeader, name) {
  const found = String(cookieHeader || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function applySetCookies(jar, response) {
  const values = response.headers.getSetCookie?.() || [];
  for (const value of values) {
    const first = value.split(";", 1)[0];
    const index = first.indexOf("=");
    if (index > 0) jar[first.slice(0, index)] = decodeURIComponent(first.slice(index + 1));
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

async function setup({ maxStartedSessions = 2000, trustLoopbackProxy = false } = {}) {
  const fixture = makeRuntime({ maxStartedSessions, trustLoopbackProxy });
  const runtime = {
    directory: fixture.directory,
    privateDir: path.join(fixture.directory, "private"),
    dataDir: path.join(fixture.directory, "data"),
    logDir: path.join(fixture.directory, "logs"),
    backupDir: path.join(fixture.directory, "private", "backups"),
    qrDir: path.join(fixture.directory, "private", "qr"),
    config: fixture.config,
    secrets: fixture.secrets,
  };
  fs.mkdirSync(runtime.dataDir, { recursive: true });
  const assessment = createAssessment(SOURCE_BUNDLE_DIR);
  const store = new SurveyStore({ dbPath: path.join(runtime.dataDir, "yy25.sqlite"), runtime, assessment });
  const servers = createServers({ runtime, store, assessment, publicDir, adminDir, logger: { error() {} } });
  const publicAddress = await listen(servers.publicServer, 0, "127.0.0.1");
  const adminAddress = await listen(servers.adminServer, 0, "127.0.0.1");
  const close = async () => {
    await Promise.all([closeServer(servers.publicServer), closeServer(servers.adminServer)]);
    store.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  };
  return { ...fixture, runtime, assessment, store, servers, publicPort: publicAddress.port, adminPort: adminAddress.port, close };
}

async function request(port, route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Host")) headers.set("Host", `127.0.0.1:${port}`);
  const requestHeaders = Object.fromEntries(headers.entries());
  const payload = options.body ? Buffer.from(String(options.body)) : null;
  const response = await new Promise((resolve, reject) => {
    const clientRequest = http.request({ hostname: "127.0.0.1", port, path: route, method: options.method || "GET", headers: requestHeaders }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: incoming.statusCode,
          text,
          headers: {
            get(name) { return incoming.headers[String(name).toLowerCase()] || null; },
            getSetCookie() { return incoming.headers["set-cookie"] || []; },
          },
        });
      });
    });
    clientRequest.on("error", reject);
    if (payload) clientRequest.write(payload);
    clientRequest.end();
  });
  const text = response.text || "";
  let body = text;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { response, body, text };
}

function withPublicHeaders(jar, port, extra = {}) {
  return {
    Cookie: cookieHeader(jar),
    Origin: `http://127.0.0.1:${port}`,
    "X-YY25-CSRF": jar.yy25_csrf || "",
    ...extra,
  };
}

test("production public HTTP requests redirect to the configured HTTPS origin", async (t) => {
  const fixture = await setup();
  t.after(fixture.close);
  fixture.runtime.config.public.allowInsecureLocal = false;
  fixture.runtime.config.public.origin = "https://survey.yinyang25.site";
  fixture.runtime.config.public.allowedHosts = ["survey.yinyang25.site"];
  const redirected = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: "survey.yinyang25.site" } });
  assert.equal(redirected.response.status, 308);
  assert.equal(redirected.response.headers.get("location"), `https://survey.yinyang25.site/q/${fixture.inviteCode}`);
});

test("public flow is consent-gated, isolated, idempotent, and completes 30 items", async (t) => {
  const fixture = await setup();
  t.after(fixture.close);
  const jar = {};
  const entry = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: `127.0.0.1:${fixture.publicPort}` } });
  assert.equal(entry.response.status, 302);
  applySetCookies(jar, entry.response);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

  const bootstrap = await request(fixture.publicPort, "/api/bootstrap", { headers: { Cookie: cookieHeader(jar) } });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.instrument.routeVersion, fixture.assessment.adaptive.ROUTE_VERSION);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

  const beforeConsent = await request(fixture.publicPort, "/api/sessions", {
    method: "POST",
    headers: withPublicHeaders(jar, fixture.publicPort, { "Content-Type": "application/json" }),
    body: JSON.stringify({ ageConfirmed: false, consent: false, consentVersion: "test-consent-v1" }),
  });
  assert.equal(beforeConsent.response.status, 422);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

  const created = await request(fixture.publicPort, "/api/sessions", {
    method: "POST",
    headers: withPublicHeaders(jar, fixture.publicPort, { "Content-Type": "application/json" }),
    body: JSON.stringify({ ageConfirmed: true, consent: true, consentVersion: "test-consent-v1" }),
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.revision, 0);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);

  const current = await request(fixture.publicPort, `/api/sessions/${created.body.sessionId}/current`, { headers: { Cookie: cookieHeader(jar) } });
  assert.equal(current.response.status, 200);
  assert.equal(current.body.question.progress.total, 30);

  const wrongCsrf = await request(fixture.publicPort, `/api/sessions/${created.body.sessionId}/answer`, {
    method: "POST",
    headers: { Cookie: cookieHeader(jar), Origin: `http://127.0.0.1:${fixture.publicPort}`, "X-YY25-CSRF": "wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ questionId: current.body.question.id, answer: 3, durationMs: 1, expectedRevision: 0 }),
  });
  assert.equal(wrongCsrf.response.status, 403);

  let answerState = current.body;
  let firstAnswerPayload;
  let answerCount = 0;
  while (answerState.question) {
    const answer = answerState.question.id === "Q112" ? 4 : answerState.question.id === "Q113" ? 3 : 3;
    const payload = { questionId: answerState.question.id, answer, durationMs: 12, expectedRevision: answerState.revision };
    if (!firstAnswerPayload) firstAnswerPayload = payload;
    const submitted = await request(fixture.publicPort, `/api/sessions/${answerState.sessionId}/answer`, {
      method: "POST",
      headers: withPublicHeaders(jar, fixture.publicPort, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    assert.equal(submitted.response.status, 200);
    answerState = submitted.body;
    answerCount += 1;
    assert.ok(answerCount <= 30, "route must not exceed 30 answers");
  }
  assert.equal(answerCount, 30);
  assert.equal(answerState.status, "completed");
  assert.equal(Object.keys(answerState.result.shapeScores).length, 5);
  assert.ok(Object.hasOwn(answerState.result, "typeStatus"));
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM answer_events").get().count, 30);

  const duplicate = await request(fixture.publicPort, `/api/sessions/${answerState.sessionId}/answer`, {
    method: "POST",
    headers: withPublicHeaders(jar, fixture.publicPort, { "Content-Type": "application/json" }),
    body: JSON.stringify(firstAnswerPayload),
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM answer_events").get().count, 30);

  const malformedCookie = await request(fixture.publicPort, "/api/bootstrap", { headers: { Cookie: "yy25_access=%E0%A4%A" } });
  assert.equal(malformedCookie.response.status, 404);
  for (const blocked of ["/data.js", "/adaptive.js", "/codebook.js", "/admin.html", "/healthz"]) {
    const result = await request(fixture.publicPort, blocked, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(result.response.status, 404, blocked);
  }
});

test("host, origin, capacity, admin isolation, and quality rules are enforced", async (t) => {
  const fixture = await setup({ maxStartedSessions: 1 });
  t.after(fixture.close);
  const jarA = {};
  const entryA = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: `127.0.0.1:${fixture.publicPort}` } });
  applySetCookies(jarA, entryA.response);
  const createdA = await request(fixture.publicPort, "/api/sessions", { method: "POST", headers: withPublicHeaders(jarA, fixture.publicPort, { "Content-Type": "application/json" }), body: JSON.stringify({ ageConfirmed: true, consent: true, consentVersion: "test-consent-v1" }) });
  assert.equal(createdA.response.status, 201);
  const firstA = await request(fixture.publicPort, `/api/sessions/${createdA.body.sessionId}/answer`, { method: "POST", headers: withPublicHeaders(jarA, fixture.publicPort, { "Content-Type": "application/json" }), body: JSON.stringify({ questionId: createdA.body.question.id, answer: 3, durationMs: 1, expectedRevision: 0 }) });
  assert.equal(firstA.response.status, 200);

  const jarB = {};
  const entryB = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: `127.0.0.1:${fixture.publicPort}` } });
  applySetCookies(jarB, entryB.response);
  const createdB = await request(fixture.publicPort, "/api/sessions", { method: "POST", headers: withPublicHeaders(jarB, fixture.publicPort, { "Content-Type": "application/json" }), body: JSON.stringify({ ageConfirmed: true, consent: true, consentVersion: "test-consent-v1" }) });
  assert.equal(createdB.response.status, 201, "consented but unstarted sessions do not consume the started cap");
  const capped = await request(fixture.publicPort, `/api/sessions/${createdB.body.sessionId}/answer`, { method: "POST", headers: withPublicHeaders(jarB, fixture.publicPort, { "Content-Type": "application/json" }), body: JSON.stringify({ questionId: createdB.body.question.id, answer: 3, durationMs: 1, expectedRevision: 0 }) });
  assert.equal(capped.response.status, 429);

  const wrongOrigin = await request(fixture.publicPort, `/api/sessions/${createdA.body.sessionId}/answer`, { method: "POST", headers: withPublicHeaders(jarA, fixture.publicPort, { Origin: "https://evil.example", "Content-Type": "application/json" }), body: JSON.stringify({ questionId: firstA.body.question.id, answer: 3, durationMs: 1, expectedRevision: 1 }) });
  assert.equal(wrongOrigin.response.status, 403);
  const wrongHost = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: "evil.example" } });
  assert.equal(wrongHost.response.status, 421);

  const publicAdmin = await request(fixture.publicPort, "/api/admin/campaigns", { headers: { Cookie: cookieHeader(jarA), Authorization: `Bearer ${fixture.secrets.adminToken}` } });
  assert.equal(publicAdmin.response.status, 404);
  const adminPage = await request(fixture.adminPort, "/", { headers: { Authorization: `Bearer ${fixture.secrets.adminToken}` } });
  assert.equal(adminPage.response.status, 200);
  const adminCampaigns = await request(fixture.adminPort, "/api/admin/campaigns", { headers: { Authorization: `Bearer ${fixture.secrets.adminToken}` } });
  assert.equal(adminCampaigns.response.status, 200);
  assert.equal(adminCampaigns.body.campaigns.length, 1);
  const csv = await request(fixture.adminPort, "/api/admin/export.csv?campaign=test-campaign", { headers: { Authorization: `Bearer ${fixture.secrets.adminToken}` } });
  assert.equal(csv.response.status, 200);
  assert.equal(csv.text.includes(fixture.inviteCode), false);

  const allAnswers = Object.fromEntries(fixture.assessment.data.questions.map((question) => [question.id, 3]));
  const invalidQ112 = fixture.assessment.adaptive.calculateAssessment(fixture.assessment.data, { ...allAnswers, Q112: 3 }, { codebook: fixture.assessment.codebook });
  const invalidQ113 = fixture.assessment.adaptive.calculateAssessment(fixture.assessment.data, { ...allAnswers, Q112: 4, Q113: 4 }, { codebook: fixture.assessment.codebook });
  assert.equal(invalidQ112.quality.status, "invalid");
  assert.equal(invalidQ113.quality.status, "invalid");
  const suppressed = fixture.assessment.calculateResult({ answers: { ...allAnswers, Q112: 3 } });
  assert.equal(suppressed.typeStatus, "insufficient_evidence");
  assert.equal(suppressed.candidateType, null);
});

test("100 concurrent first answers work through distinct IPv6 edge identities", async (t) => {
  const fixture = await setup({ maxStartedSessions: 2000, trustLoopbackProxy: true });
  t.after(fixture.close);
  const participants = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const edgeIp = `2001:db8::${index + 1}`;
    const jar = {};
    const entry = await request(fixture.publicPort, `/q/${fixture.inviteCode}`, { headers: { Host: `127.0.0.1:${fixture.publicPort}`, "CF-Connecting-IP": edgeIp } });
    assert.equal(entry.response.status, 302);
    applySetCookies(jar, entry.response);
    const created = await request(fixture.publicPort, "/api/sessions", {
      method: "POST",
      headers: withPublicHeaders(jar, fixture.publicPort, { "Content-Type": "application/json", "CF-Connecting-IP": edgeIp }),
      body: JSON.stringify({ ageConfirmed: true, consent: true, consentVersion: "test-consent-v1" }),
    });
    assert.equal(created.response.status, 201);
    return { edgeIp, jar, state: created.body };
  }));
  const responses = await Promise.all(participants.map(async (participant) => request(fixture.publicPort, `/api/sessions/${participant.state.sessionId}/answer`, {
    method: "POST",
    headers: withPublicHeaders(participant.jar, fixture.publicPort, { "Content-Type": "application/json", "CF-Connecting-IP": participant.edgeIp }),
    body: JSON.stringify({ questionId: participant.state.question.id, answer: 3, durationMs: 5, expectedRevision: 0 }),
  })));
  assert.equal(responses.filter((response) => response.response.status === 200).length, 100);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE started_at IS NOT NULL").get().count, 100);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM answer_events").get().count, 100);
});

test("retention cleanup removes expired sessions, short-lived rate metadata, and old audit rows", async (t) => {
  const fixture = await setup();
  t.after(fixture.close);
  const oldNow = "2020-01-01T00:00:00.000Z";
  const created = fixture.store.createConsentedSession({
    campaign: fixture.runtime.config.campaigns[0],
    ownerHash: "retention-owner",
    consentVersion: "test-consent-v1",
    now: oldNow,
  });
  assert.ok(created.row.id);
  fixture.store.consumeRate({ keyHash: "old-rate-key", action: "test", limit: 5, windowMs: 60_000, retentionHours: 24, now: new Date(oldNow) });
  const cleaned = fixture.store.cleanup("2021-01-01T00:00:00.000Z");
  assert.equal(cleaned.sessions, 1);
  assert.equal(cleaned.rates, 1);
  assert.ok(cleaned.audit >= 1);
  assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

