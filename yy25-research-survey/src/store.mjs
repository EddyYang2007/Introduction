import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { csvCell, isoNow } from "./security.mjs";

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function plusDays(now, days) {
  return new Date(Date.parse(now) + days * 24 * 60 * 60 * 1000).toISOString();
}

function minusHours(now, hours) {
  return new Date(Date.parse(now) - hours * 60 * 60 * 1000).toISOString();
}

function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        study_phase TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_started_sessions INTEGER NOT NULL,
        context_json TEXT NOT NULL,
        invite_code_hash TEXT NOT NULL,
        instrument_version TEXT NOT NULL,
        codebook_version TEXT NOT NULL,
        route_version TEXT NOT NULL,
        scoring_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        owner_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        answer_count INTEGER NOT NULL DEFAULT 0,
        consent_version TEXT NOT NULL,
        consented_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        result_json TEXT,
        instrument_version TEXT NOT NULL,
        source_manifest_json TEXT NOT NULL,
        codebook_version TEXT NOT NULL,
        route_version TEXT NOT NULL,
        scoring_version TEXT NOT NULL,
        study_phase TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delete_after TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS answer_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        answer_value TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        answered_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS exposure_counts (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (campaign_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS rate_windows (
        key_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (key_hash, action, bucket_start)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        campaign_id TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_campaign_status ON sessions(campaign_id, status);
      CREATE INDEX IF NOT EXISTS idx_sessions_delete_after ON sessions(delete_after);
      CREATE INDEX IF NOT EXISTS idx_answer_events_session ON answer_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_rate_windows_expiry ON rate_windows(expires_at);
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
    `,
  },
];

export class SurveyStore {
  constructor({ dbPath, runtime, assessment }) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.runtime = runtime;
    this.assessment = assessment;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA trusted_schema=OFF;");
    this.migrate();
    this.seedCampaigns();
    this.prepare();
  }

  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      transaction(this.db, () => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, isoNow());
        this.db.exec(`PRAGMA user_version=${migration.version}`);
      });
    }
  }

  seedCampaigns() {
    const now = isoNow();
    const versions = {
      instrumentVersion: this.assessment.instrumentVersion,
      codebookVersion: this.assessment.codebook.version,
      routeVersion: this.assessment.adaptive.ROUTE_VERSION,
      scoringVersion: this.assessment.adaptive.SCORING_VERSION,
    };
    const insert = this.db.prepare(`INSERT INTO campaigns
      (id,name,study_phase,status,expires_at,max_started_sessions,context_json,invite_code_hash,instrument_version,codebook_version,route_version,scoring_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, study_phase=excluded.study_phase, status=excluded.status, expires_at=excluded.expires_at,
        max_started_sessions=excluded.max_started_sessions, context_json=excluded.context_json,
        invite_code_hash=excluded.invite_code_hash, updated_at=excluded.updated_at`);
    for (const campaign of this.runtime.config.campaigns) {
      insert.run(
        campaign.id,
        campaign.name,
        campaign.studyPhase,
        campaign.status,
        campaign.expiresAt,
        campaign.maxStartedSessions,
        JSON.stringify(campaign.context || {}),
        campaign.inviteCodeHash,
        versions.instrumentVersion,
        versions.codebookVersion,
        versions.routeVersion,
        versions.scoringVersion,
        now,
        now,
      );
    }
  }

  prepare() {
    this.statements = {
      sessionById: this.db.prepare("SELECT * FROM sessions WHERE id = ?"),
      countStarted: this.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE campaign_id = ? AND started_at IS NOT NULL"),
      insertSession: this.db.prepare(`INSERT INTO sessions
        (id,campaign_id,owner_hash,status,revision,answer_count,consent_version,consented_at,state_json,result_json,instrument_version,source_manifest_json,codebook_version,route_version,scoring_version,study_phase,started_at,completed_at,created_at,updated_at,delete_after)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      updateSession: this.db.prepare(`UPDATE sessions SET status=?,revision=?,answer_count=?,state_json=?,result_json=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND revision=?`),
      insertEvent: this.db.prepare("INSERT INTO answer_events (session_id,sequence,question_id,stage,answer_value,duration_ms,answered_at) VALUES (?,?,?,?,?,?,?)"),
      exposureByCampaign: this.db.prepare("SELECT question_id,count FROM exposure_counts WHERE campaign_id = ?"),
      incrementExposure: this.db.prepare(`INSERT INTO exposure_counts (campaign_id,question_id,count,updated_at) VALUES (?,?,1,?)
        ON CONFLICT(campaign_id,question_id) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`),
      rateByKey: this.db.prepare("SELECT count FROM rate_windows WHERE key_hash=? AND action=? AND bucket_start=?"),
      insertRate: this.db.prepare("INSERT INTO rate_windows (key_hash,action,bucket_start,count,expires_at) VALUES (?,?,?,?,?)"),
      incrementRate: this.db.prepare("UPDATE rate_windows SET count=count+1, expires_at=? WHERE key_hash=? AND action=? AND bucket_start=?"),
      deleteRates: this.db.prepare("DELETE FROM rate_windows WHERE expires_at <= ?"),
      deleteExpiredSessions: this.db.prepare("DELETE FROM sessions WHERE delete_after <= ?"),
      deleteStaleUnstarted: this.db.prepare("DELETE FROM sessions WHERE status='consented' AND started_at IS NULL AND created_at <= ?"),
      deleteOldAudit: this.db.prepare("DELETE FROM audit_log WHERE created_at <= ?"),
      allCampaigns: this.db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC"),
      campaignById: this.db.prepare("SELECT * FROM campaigns WHERE id=?"),
      recordsForCampaign: this.db.prepare("SELECT * FROM sessions WHERE campaign_id=? ORDER BY created_at ASC"),
      insertAudit: this.db.prepare("INSERT INTO audit_log (event_type,campaign_id,details_json,created_at) VALUES (?,?,?,?)"),
    };
  }

  close() {
    this.db.close();
  }

  campaign(id) {
    return this.runtime.config.campaigns.find((campaign) => campaign.id === id) || null;
  }

  exposure(campaignId) {
    return Object.fromEntries(this.statements.exposureByCampaign.all(campaignId).map((row) => [row.question_id, Number(row.count)]));
  }

  incrementExposure(campaignId, questionIds, now) {
    for (const questionId of new Set(questionIds || [])) this.statements.incrementExposure.run(campaignId, questionId, now);
  }

  getRecord(id) {
    const row = this.statements.sessionById.get(id);
    if (!row) return null;
    const state = parseJson(row.state_json, null);
    if (!state) return null;
    return { row, state, result: parseJson(row.result_json, null) };
  }

  createConsentedSession({ campaign, ownerHash, consentVersion, now = isoNow() }) {
    return transaction(this.db, () => {
      const exposure = this.exposure(campaign.id);
      const created = this.assessment.createInitialState({ campaign, exposure, now });
      const state = created.state;
      state.researchSession = {
        ...state.researchSession,
        consentVersion,
        consentedAt: now,
        ageMinimum: this.runtime.config.privacy.ageMinimum,
      };
      const deleteAfter = plusDays(now, this.runtime.config.privacy.retentionDays);
      this.statements.insertSession.run(
        created.id,
        campaign.id,
        ownerHash,
        "consented",
        0,
        0,
        consentVersion,
        now,
        JSON.stringify(state),
        null,
        this.assessment.instrumentVersion,
        JSON.stringify(this.assessment.manifest),
        state.route.codebookVersion,
        state.route.version,
        state.route.scoringVersion,
        campaign.studyPhase,
        null,
        null,
        now,
        now,
        deleteAfter,
      );
      this.incrementExposure(campaign.id, created.initialExposureIds, now);
      this.statements.insertAudit.run("session_consented", campaign.id, JSON.stringify({ sessionId: created.id }), now);
      return this.getRecord(created.id);
    });
  }

  answerSession({ id, ownerHash, expectedRevision, questionId, answer, durationMs, now = isoNow() }) {
    return transaction(this.db, () => {
      const record = this.getRecord(id);
      if (!record || record.row.owner_hash !== ownerHash) return { error: "not_found" };
      if (!record.row.started_at) {
        const campaign = this.campaign(record.row.campaign_id);
        const started = Number(this.statements.countStarted.get(record.row.campaign_id).count || 0);
        if (campaign && started >= Number(campaign.maxStartedSessions)) return { error: "campaign_limit" };
      }
      const currentRevision = Number(record.row.revision);
      if (expectedRevision < currentRevision && record.state.answers?.[questionId] !== undefined && String(record.state.answers[questionId]) === String(answer)) {
        return { record, idempotent: true };
      }
      if (expectedRevision !== currentRevision) return { error: "question_order" };
      const exposure = this.exposure(record.row.campaign_id);
      const applied = this.assessment.applyAnswer(record.state, {
        questionId,
        answer,
        durationMs,
        now,
        exposure,
      });
      if (applied.error) return { error: applied.error };
      record.state.revision = currentRevision + 1;
      const status = applied.result ? "completed" : "in_progress";
      const startedAt = record.state.researchSession.startedAt || record.row.started_at || now;
      const completedAt = applied.result ? (record.state.researchSession.completedAt || now) : null;
      const update = this.statements.updateSession.run(
        status,
        record.state.revision,
        this.assessment.countAnswered(record.state),
        JSON.stringify(record.state),
        applied.result ? JSON.stringify(this.assessment.resultDto(applied.result)) : null,
        startedAt,
        completedAt,
        now,
        id,
        currentRevision,
      );
      if (Number(update.changes) !== 1) throw new Error("session revision update failed");
      this.statements.insertEvent.run(
        id,
        record.state.researchSession.events.length,
        applied.item.id,
        applied.item.stage,
        String(applied.value),
        Math.max(0, Math.min(Number(durationMs) || 0, 15 * 60 * 1000)),
        now,
      );
      this.incrementExposure(record.row.campaign_id, applied.newExposureIds, now);
      const updated = this.getRecord(id);
      return { record: updated, idempotent: false };
    });
  }

  deleteOwnedSession({ id, ownerHash, now = isoNow() }) {
    return transaction(this.db, () => {
      const record = this.getRecord(id);
      if (!record || record.row.owner_hash !== ownerHash) return false;
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.statements.insertAudit.run("session_withdrawn", record.row.campaign_id, JSON.stringify({ sessionId: id }), now);
      return true;
    });
  }

  consumeRate({ keyHash, action, limit, windowMs, retentionHours, now = new Date() }) {
    const bucketStart = Math.floor(now.getTime() / windowMs) * windowMs;
    const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
    return transaction(this.db, () => {
      const existing = this.statements.rateByKey.get(keyHash, action, bucketStart);
      if (!existing) {
        this.statements.insertRate.run(keyHash, action, bucketStart, 1, expiresAt);
        return { ok: true, retryAfter: 0 };
      }
      if (Number(existing.count) >= limit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((bucketStart + windowMs - now.getTime()) / 1000)) };
      }
      this.statements.incrementRate.run(expiresAt, keyHash, action, bucketStart);
      return { ok: true, retryAfter: 0 };
    });
  }

  cleanup(now = isoNow()) {
    return transaction(this.db, () => {
      const rates = Number(this.statements.deleteRates.run(now).changes || 0);
      const sessions = Number(this.statements.deleteExpiredSessions.run(now).changes || 0);
      const configuredHours = Number(this.runtime.config.privacy.unstartedRetentionHours ?? 24);
      const unstarted = Number(this.statements.deleteStaleUnstarted.run(minusHours(now, Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 24)).changes || 0);
      const auditCutoff = plusDays(now, -Number(this.runtime.config.privacy.retentionDays));
      const audit = Number(this.statements.deleteOldAudit.run(auditCutoff).changes || 0);
      this.statements.insertAudit.run("retention_cleanup", null, JSON.stringify({ rates, sessions, unstarted, audit }), now);
      return { rates, sessions, unstarted, audit };
    });
  }

  listCampaigns() {
    return this.statements.allCampaigns.all().map((row) => ({
      id: row.id,
      name: row.name,
      studyPhase: row.study_phase,
      status: row.status,
      expiresAt: row.expires_at,
      maxStartedSessions: Number(row.max_started_sessions),
      context: parseJson(row.context_json, {}),
    }));
  }

  campaignSummary(campaignId) {
    const records = this.statements.recordsForCampaign.all(campaignId).map((row) => ({
      row,
      state: parseJson(row.state_json, {}),
      result: parseJson(row.result_json, null),
    }));
    const starts = records.filter(({ row }) => row.started_at).length;
    const completed = records.filter(({ row }) => row.status === "completed");
    const durations = completed.map(({ row }) => {
      const start = Date.parse(row.started_at || "");
      const end = Date.parse(row.completed_at || "");
      return start && end && end >= start && end - start < 24 * 60 * 60 * 1000 ? end - start : 0;
    }).filter(Boolean);
    const exitDistribution = {};
    const profileDistribution = {};
    for (const { row, state, result } of records) {
      const last = [...(state.researchSession?.events || [])].pop();
      if (row.status !== "completed" && last?.questionId) exitDistribution[last.questionId] = (exitDistribution[last.questionId] || 0) + 1;
      if (row.status === "completed") {
        const label = result?.profile?.name || (result?.typeStatus === "insufficient_evidence" ? "证据不足" : "未完成");
        profileDistribution[label] = (profileDistribution[label] || 0) + 1;
      }
    }
    const invalid = completed.filter(({ result }) => result?.quality?.status === "invalid").length;
    return {
      campaignId,
      consented: records.length,
      starts,
      completions: completed.length,
      completionRate: records.length ? completed.length / records.length : 0,
      averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      invalidRate: completed.length ? invalid / completed.length : 0,
      analysisEligibleCount: completed.filter(({ result }) => result?.analysisEligible).length,
      exitQuestionDistribution: exitDistribution,
      profileDistribution,
    };
  }

  exportCsv(campaignId, now = isoNow()) {
    const headers = [
      "session_id", "campaign_id", "status", "consent_version", "consented_at", "started_at", "completed_at",
      "instrument_version", "route_version", "scoring_version", "question_id", "stage", "answer", "duration_ms",
      "quality_status", "analysis_eligible", "candidate_type", "profile_name",
    ];
    const rows = [headers.map(csvCell).join(",")];
    for (const row of this.statements.recordsForCampaign.all(campaignId)) {
      const state = parseJson(row.state_json, {});
      const result = parseJson(row.result_json, null);
      const events = state.researchSession?.events?.length ? state.researchSession.events : [{}];
      for (const event of events) {
        rows.push([
          row.id,
          row.campaign_id,
          row.status,
          row.consent_version,
          row.consented_at,
          row.started_at,
          row.completed_at,
          row.instrument_version,
          row.route_version,
          row.scoring_version,
          event.questionId,
          event.stage,
          event.value,
          event.durationMs,
          result?.quality?.status || "",
          result?.analysisEligible ?? "",
          result?.candidateType || "",
          result?.profile?.name || "",
        ].map(csvCell).join(","));
      }
    }
    this.statements.insertAudit.run("admin_export", campaignId, JSON.stringify({ format: "csv" }), now);
    return `\uFEFF${rows.join("\r\n")}\r\n`;
  }

  backupTo(destination) {
    const normalized = path.resolve(destination);
    if (normalized === path.resolve(this.dbPath)) throw new Error("backup destination must differ from active database");
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    const integrity = this.db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error(`database integrity check failed: ${integrity}`);
    this.db.exec(`VACUUM INTO '${normalized.replace(/'/g, "''")}'`);
    const backup = new DatabaseSync(normalized, { readOnly: true });
    try {
      const backupIntegrity = backup.prepare("PRAGMA integrity_check").get().integrity_check;
      if (backupIntegrity !== "ok") throw new Error(`backup integrity check failed: ${backupIntegrity}`);
    } finally {
      backup.close();
    }
    return normalized;
  }
}

