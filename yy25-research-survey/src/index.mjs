import path from "node:path";
import { loadRuntime, PROJECT_ROOT, SOURCE_BUNDLE_DIR } from "./config.mjs";
import { createAssessment } from "./assessment.mjs";
import { SurveyStore } from "./store.mjs";
import { closeServer, createServers, listen } from "./http.mjs";

const runtime = loadRuntime();
const assessment = createAssessment(SOURCE_BUNDLE_DIR);
const store = new SurveyStore({
  dbPath: path.join(runtime.dataDir, "yy25.sqlite"),
  runtime,
  assessment,
});
store.cleanup();

const { publicServer, adminServer } = createServers({
  runtime,
  store,
  assessment,
  publicDir: path.join(PROJECT_ROOT, "public"),
  adminDir: path.join(PROJECT_ROOT, "admin"),
});

await listen(publicServer, runtime.config.public.publicPort, runtime.config.public.publicHost);
await listen(adminServer, runtime.config.public.adminPort, runtime.config.public.adminHost);
console.log(`YY25 public listener: ${runtime.config.public.publicHost}:${runtime.config.public.publicPort}`);
console.log(`YY25 local admin listener: ${runtime.config.public.adminHost}:${runtime.config.public.adminPort}`);

const cleanupTimer = setInterval(() => {
  try { store.cleanup(); } catch (error) { console.error(`[yy25] retention cleanup failed: ${error?.name || "Error"}`); }
}, 60 * 60 * 1000);
cleanupTimer.unref();

async function shutdown() {
  clearInterval(cleanupTimer);
  await Promise.all([closeServer(publicServer), closeServer(adminServer)]);
  store.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

