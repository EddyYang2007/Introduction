import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { sha256, cleanText } from "./security.mjs";

const SOURCE_FILES = ["data.js", "codebook-metadata.js", "codebook.js", "adaptive.js"];
const MISSING_VALUES = new Set(["uncertain", "not_applicable", "unable_to_judge", "prefer_not_to_answer"]);

function sourceManifest(bundleDir) {
  return Object.fromEntries(SOURCE_FILES.map((name) => {
    const file = path.join(bundleDir, name);
    return [name, sha256(fs.readFileSync(file))];
  }));
}
function loadSourceBundle(bundleDir) {
  const context = { window: {}, globalThis: {} };
  context.window.window = context.window;
  vm.createContext(context);
  for (const file of SOURCE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(bundleDir, file), "utf8"), context, { filename: file, displayErrors: true });
  }
  const data = context.window.YY25_DATA;
  const codebook = context.window.YY25_CODEBOOK;
  const adaptive = context.window.YY25_ADAPTIVE;
  if (!data || !codebook || !adaptive) throw new Error("YY25 source bundle failed to load");
  return { data, codebook, adaptive };
}

function routeSnapshot(route) {
  return (route.items || []).map((item, index) => ({
    position: index + 1,
    questionId: item.id,
    stage: item.stage,
    targetElements: [...(item.targetElements || [])],
    reason: cleanText(item.reason, 160),
  }));
}

function isStageComplete(state, stage) {
  const items = state.route.items.filter((item) => item.stage === stage);
  return items.length > 0 && items.every((item) => state.answers[item.id] !== undefined && state.answers[item.id] !== "");
}

function nextRouteItem(state) {
  const answered = state.answers || {};
  return (state.route.items || []).find((item) => answered[item.id] === undefined || answered[item.id] === "") || null;
}

function countAnswered(state) {
  return Object.keys(state.answers || {}).length;
}

function normalizeAnswer(questionId, value) {
  if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
  if (typeof value === "string" && MISSING_VALUES.has(value) && questionId !== "Q112") return value;
  return null;
}

function resultDto(result) {
  if (!result) return null;
  const profile = result.outputProfile;
  return {
    instrumentVersion: result.instrumentVersion,
    sourceManifest: result.sourceManifest,
    codebookVersion: result.codebookVersion,
    routeVersion: result.routeVersion,
    scoringVersion: result.scoringVersion,
    studyPhase: result.studyPhase,
    typeStatus: result.typeStatus,
    candidateType: result.candidateType,
    topShape: result.topShape,
    secondShape: result.secondShape,
    rankedShapes: result.rankedShapes,
    shapeScores: result.shapeScores,
    shapeConfidence: result.shapeConfidence,
    profileConfidence: result.profileConfidence,
    profileCoverage: result.profileCoverage,
    profileScores: result.profileScores,
    quality: result.quality,
    analysisEligible: result.analysisEligible,
    presentationTier: result.presentationTier,
    yinYang: result.yinYang,
    topState: result.topState,
    stateMatched: result.stateMatched,
    laterality: result.laterality,
    shapeGap: result.shapeGap,
    profileGap: result.profileGap,
    profile: profile ? {
      id: profile.id,
      name: profile.name,
      classicName: profile.classicName,
      element: profile.element,
      code: profile.code,
      oneSentence: profile.oneSentence,
      logic: profile.logic,
      expression: profile.expression,
      imbalanceScene: profile.imbalanceScene,
      fitContext: profile.fitContext,
      warning: profile.warning,
      advice: profile.advice,
      musicPrescription: profile.musicPrescription,
      nourishMusic: profile.nourishMusic,
      balanceMusic: profile.balanceMusic,
      bestTime: profile.bestTime,
      growth: profile.growth,
      disclaimer: profile.disclaimer,
    } : null,
  };
}

export function createAssessment(bundleDir) {
  const { data, codebook, adaptive } = loadSourceBundle(bundleDir);
  const questionById = new Map(data.questions.map((question) => [question.id, question]));
  const manifest = sourceManifest(bundleDir);
  const instrumentVersion = "yy25-v0.8-public-research";

  function createInitialState({ campaign, exposure, now }) {
    const seed = crypto.randomInt(1, 2 ** 31 - 1);
    const route = adaptive.createInitialRoute(data, { codebook, exposure, seed, now });
    const id = crypto.randomUUID();
    const researchSession = adaptive.createResearchSession(route, {
      id,
      now,
      context: { ...(campaign.context || {}) },
      deferStart: true,
    });
    return {
      id,
      state: {
        route,
        answers: {},
        researchSession,
        revision: 0,
      },
      initialExposureIds: route.items.map((item) => item.id),
    };
  }

  function rebuildRoute(state, exposure, reason, now) {
    const existingIds = new Set(state.route.items.map((item) => item.id));
    const profileItems = state.route.items.filter((item) => item.stage === "adaptiveProfile");
    const conflictItems = state.route.items.filter((item) => item.stage === "conflict");
    if (profileItems.length !== 9 && isStageComplete(state, "mainShape")) {
      state.route = adaptive.resolveProfileStage(data, state.route, state.answers, {
        codebook,
        exposure,
        seed: state.route.seed,
        reason,
        now,
      });
    }
    const refreshedProfile = state.route.items.filter((item) => item.stage === "adaptiveProfile");
    if (conflictItems.length !== 2 && refreshedProfile.length === 9 && isStageComplete(state, "adaptiveProfile")) {
      state.route = adaptive.resolveConflictStage(data, state.route, state.answers, {
        codebook,
        exposure,
        seed: state.route.seed,
        reason,
        now,
      });
    }
    state.researchSession = {
      ...state.researchSession,
      route: routeSnapshot(state.route),
      routeRebuildLog: [...(state.route.rebuildLog || [])],
      invalidatedAnswers: [...(state.route.invalidatedAnswers || [])],
    };
    return state.route.items.filter((item) => !existingIds.has(item.id)).map((item) => item.id);
  }

  function calculateResult(state) {
    const result = adaptive.calculateAssessment(data, state.answers, { codebook });
    const evidenceSufficient = result.quality.status !== "invalid" && result.analysisEligible !== false && result.profileConfidence !== "low";
    const profile = evidenceSufficient ? result.outputProfile : null;
    return {
      instrumentVersion,
      sourceManifest: manifest,
      codebookVersion: result.codebookVersion,
      routeVersion: result.routeVersion,
      scoringVersion: result.scoringVersion,
      studyPhase: result.studyPhase,
      typeStatus: profile ? "research_candidate" : "insufficient_evidence",
      candidateType: profile ? profile.id : null,
      topShape: result.topShape,
      secondShape: result.secondShape,
      rankedShapes: result.rankedShapes,
      shapeScores: result.shapeScores,
      shapeConfidence: result.shapeConfidence,
      profileConfidence: result.profileConfidence,
      profileCoverage: result.profileCoverage,
      bestProfile: result.bestProfile ? { ...result.bestProfile, profile } : null,
      outputProfile: profile,
      profileScores: (result.profileScores || []).slice(0, 5),
      quality: result.quality,
      analysisEligible: Boolean(result.analysisEligible && evidenceSufficient),
      presentationTier: profile ? result.presentationTier : "lowEvidence",
      yinYang: result.yinYang,
      topState: result.topState,
      stateMatched: result.stateMatched,
      laterality: result.laterality,
      shapeGap: result.shapeGap,
      profileGap: result.profileGap,
    };
  }

  function questionDto(state) {
    const item = nextRouteItem(state);
    if (!item) return null;
    const question = questionById.get(item.id);
    const code = codebook.questions[item.id] || {};
    return {
      id: question.id,
      text: question.text,
      stage: item.stage,
      number: question.number,
      naAllowed: Boolean(code.naAllowed && question.id !== "Q112"),
      progress: { answered: countAnswered(state), total: 30 },
    };
  }

  function publicState(row, state, result, campaign) {
    return {
      sessionId: row.id,
      revision: Number(row.revision),
      status: row.status,
      question: questionDto(state),
      result: resultDto(result),
      campaign: {
        id: campaign.id,
        name: campaign.name,
        studyPhase: campaign.studyPhase,
        expiresAt: campaign.expiresAt,
      },
      instrument: {
        version: instrumentVersion,
        sourceManifest: manifest,
        routeVersion: state.route.version,
        codebookVersion: state.route.codebookVersion,
        scoringVersion: state.route.scoringVersion,
      },
    };
  }

  function recordAnswer(state, item, value, now) {
    state.answers[item.id] = value;
    state.researchSession = adaptive.recordAnswerEvent(state.researchSession, item, value, { durationMs: 0, now });
  }

  function applyAnswer(state, { questionId, answer, durationMs, now, exposure }) {
    const item = nextRouteItem(state);
    const normalized = normalizeAnswer(questionId, answer);
    if (!item || item.id !== questionId || normalized === null) return { error: "invalid_answer" };
    if (!state.researchSession.startedAt) state.researchSession = { ...state.researchSession, startedAt: now };
    state.answers[item.id] = normalized;
    state.researchSession = adaptive.recordAnswerEvent(state.researchSession, item, normalized, { durationMs, now });
    const newExposureIds = rebuildRoute(state, exposure, `${item.stage}_completed`, now);
    let result = null;
    if (!nextRouteItem(state)) {
      result = calculateResult(state);
      state.researchSession = adaptive.completeResearchSession(state.researchSession, result, { route: state.route, now });
      state.researchSession.resultSummary = {
        ...state.researchSession.resultSummary,
        typeStatus: result.typeStatus,
        candidateType: result.candidateType,
      };
    }
    return { item, value: normalized, result, newExposureIds };
  }

  return {
    data,
    codebook,
    adaptive,
    manifest,
    instrumentVersion,
    createInitialState,
    applyAnswer,
    calculateResult,
    publicState,
    questionDto,
    resultDto,
    nextRouteItem,
    countAnswered,
    routeSnapshot,
  };
}

