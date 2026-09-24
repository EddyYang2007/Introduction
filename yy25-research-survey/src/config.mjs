import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./security.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_BUNDLE_DIR = path.join(PROJECT_ROOT, "source-bundle");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${file}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function integerFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed > 0 && parsed < 65536, `${name} must be a valid TCP port`);
  return parsed;
}

function normalizeOrigin(value) {
  const origin = String(value || "").replace(/\/$/, "");
  const parsed = new URL(origin);
  assert(parsed.pathname === "/" && !parsed.search && !parsed.hash, "public.origin must be an origin only");
  return origin;
}

function validateCampaign(campaign, secrets) {
  assert(/^[a-z0-9][a-z0-9-]{2,63}$/i.test(campaign.id), `invalid campaign id: ${campaign.id}`);
  assert(typeof campaign.name === "string" && campaign.name.length > 0 && campaign.name.length <= 120, `invalid campaign name: ${campaign.id}`);
  assert(typeof campaign.studyPhase === "string" && campaign.studyPhase.length > 0 && campaign.studyPhase.length <= 80, `invalid study phase: ${campaign.id}`);
  assert(["active", "paused", "revoked"].includes(campaign.status), `invalid campaign status: ${campaign.id}`);
  assert(Number.isFinite(Date.parse(campaign.expiresAt)), `invalid campaign expiration: ${campaign.id}`);
  assert(Number.isInteger(campaign.maxStartedSessions) && campaign.maxStartedSessions > 0 && campaign.maxStartedSessions <= 1_000_000, `invalid maxStartedSessions: ${campaign.id}`);
  assert(/^[a-f0-9]{64}$/i.test(campaign.inviteCodeHash), `missing invite code hash: ${campaign.id}`);
  const code = secrets.inviteCodes?.[campaign.id];
  if (campaign.status === "active") {
    assert(typeof code === "string" && code.length >= 32, `missing private invite code: ${campaign.id}`);
    assert(sha256(code) === campaign.inviteCodeHash, `invite code hash mismatch: ${campaign.id}`);
  } else if (code !== undefined) {
    assert(typeof code === "string" && code.length >= 32, `invalid private invite code: ${campaign.id}`);
    assert(sha256(code) === campaign.inviteCodeHash, `invite code hash mismatch: ${campaign.id}`);
  }
}

export function runtimeDirectory(value = process.env.YY25_RUNTIME_DIR) {
  assert(value, "YY25_RUNTIME_DIR must point to a protected runtime directory");
  return path.resolve(value);
}

export function loadRuntime(options = {}) {
  const directory = runtimeDirectory(options.runtimeDir);
  const configPath = path.join(directory, "config.json");
  const privateDir = path.join(directory, "private");
  const secretsPath = path.join(privateDir, "secrets.json");
  const config = readJson(configPath);
  const secrets = readJson(secretsPath);

  assert(config.schemaVersion === 1, "unsupported runtime config schema");
  config.public.origin = normalizeOrigin(config.public?.origin);
  assert(Array.isArray(config.public?.allowedHosts) && config.public.allowedHosts.length > 0, "public.allowedHosts is required");
  config.public.allowedHosts = config.public.allowedHosts.map((host) => String(host).toLowerCase());
  assert(config.public.publicHost === "127.0.0.1" || config.public.publicHost === "::1", "public listener must bind loopback");
  assert(config.public.adminHost === "127.0.0.1" || config.public.adminHost === "::1", "admin listener must bind loopback");
  const originHost = new URL(config.public.origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  assert(config.public.allowedHosts.includes(originHost), "public.allowedHosts must include the origin host");
  config.public.publicPort = integerFromEnv("YY25_PUBLIC_PORT", Number(config.public.publicPort || 8787));
  config.public.adminPort = integerFromEnv("YY25_ADMIN_PORT", Number(config.public.adminPort || 8788));
  config.public.allowInsecureLocal = process.env.YY25_ALLOW_INSECURE_LOCAL === "1";
  assert(Number.isInteger(config.privacy?.ageMinimum) && config.privacy.ageMinimum >= 18 && config.privacy.ageMinimum <= 120, "privacy.ageMinimum must be between 18 and 120");
  assert(Number.isInteger(config.privacy?.retentionDays) && config.privacy.retentionDays >= 1 && config.privacy.retentionDays <= 3650, "privacy.retentionDays is invalid");
  assert(Number.isInteger(config.privacy?.rateMetadataRetentionHours) && config.privacy.rateMetadataRetentionHours >= 1 && config.privacy.rateMetadataRetentionHours <= 168, "privacy.rateMetadataRetentionHours is invalid");
  assert(typeof config.privacy?.consentVersion === "string" && config.privacy.consentVersion.length >= 1 && config.privacy.consentVersion.length <= 120, "privacy.consentVersion is invalid");
  assert(typeof config.privacy?.contact === "string" && config.privacy.contact.length <= 200, "privacy.contact is invalid");
  config.privacy.unstartedRetentionHours = Number(config.privacy.unstartedRetentionHours ?? 24);
  assert(Number.isInteger(config.privacy.unstartedRetentionHours) && config.privacy.unstartedRetentionHours >= 1 && config.privacy.unstartedRetentionHours <= 720, "privacy.unstartedRetentionHours is invalid");
  assert(typeof secrets.cookieSecret === "string" && secrets.cookieSecret.length >= 32, "missing cookieSecret");
  assert(typeof secrets.metadataSecret === "string" && secrets.metadataSecret.length >= 32, "missing metadataSecret");
  assert(typeof secrets.backupSecret === "string" && secrets.backupSecret.length >= 32, "missing backupSecret");
  assert(typeof secrets.adminToken === "string" && secrets.adminToken.length >= 32, "missing adminToken");
  assert(Array.isArray(config.campaigns) && config.campaigns.length > 0, "at least one campaign is required");
  for (const campaign of config.campaigns) validateCampaign(campaign, secrets);

  return {
    directory,
    privateDir,
    dataDir: path.join(directory, "data"),
    logDir: path.join(directory, "logs"),
    backupDir: path.join(privateDir, "backups"),
    qrDir: path.join(privateDir, "qr"),
    config,
    secrets,
  };
}

export function activeCampaign(runtime, code) {
  const codeHash = sha256(code);
  return runtime.config.campaigns.find((campaign) => campaign.inviteCodeHash === codeHash) || null;
}

export function campaignIsAvailable(campaign, now = Date.now()) {
  return campaign?.status === "active" && Date.parse(campaign.expiresAt) > now;
}

