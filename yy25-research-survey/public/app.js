(() => {
  "use strict";

  const app = document.querySelector("#app");
  const storageKey = "yy25.public.session";
  const answerLabels = ["非常不符合", "比较不符合", "说不清", "比较符合", "非常符合"];
  let bootstrap = null;
  let state = null;
  let questionShownAt = 0;
  let submitting = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'\"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[character]));
  }

  function icon(name) {
    return `<i data-lucide="${name}" aria-hidden="true"></i>`;
  }

  function renderIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function setContent(html) {
    app.innerHTML = html;
    renderIcons();
  }

  function header() {
    return `
      <header class="masthead">
        <img class="masthead-mark" src="/assets/five-elements-wheel.png" alt="">
        <div class="masthead-copy">
          <p class="eyebrow">${escapeHtml(bootstrap?.campaign?.studyPhase || "研究项目")}</p>
          <h1>${escapeHtml(bootstrap?.campaign?.name || "阴阳二十五人研究问卷")}</h1>
        </div>
      </header>`;
  }

  function messageFrom(error) {
    if (error?.body?.message) return error.body.message;
    if (error?.message) return error.message;
    return "服务暂时无法处理请求，请稍后重试。";
  }

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (bootstrap?.csrfToken && !headers.has("X-YY25-CSRF")) headers.set("X-YY25-CSRF", bootstrap.csrfToken);
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(body?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function savedSessionId() {
    try { return sessionStorage.getItem(storageKey) || ""; } catch { return ""; }
  }

  function saveSessionId(id) {
    try { sessionStorage.setItem(storageKey, id); } catch { /* Browser privacy mode can block storage. */ }
  }

  function clearSessionId() {
    try { sessionStorage.removeItem(storageKey); } catch { /* No stored session to remove. */ }
  }

  function renderError(title, detail, retry = true) {
    setContent(`${header()}
      <section class="tool-panel error-panel">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(detail)}</p>
        ${retry ? `<div class="actions"><button class="primary-button" type="button" data-action="retry">重新连接</button></div>` : ""}
      </section>`);
  }

  function renderConsent() {
    const consent = bootstrap.consent;
    setContent(`${header()}
      <section class="tool-panel consent-panel">
        <h2>参与确认</h2>
        <p class="intro-copy">本问卷用于研究性数据收集。结果展示为主形连续分、质量提示与研究候选信息，不构成医学、心理或其他专业诊断。</p>
        <ul class="consent-details">
          <li><strong>收集内容</strong>逐题答案、答题时长、研究结果与量表版本。</li>
          <li><strong>使用与保存</strong>用于本研究的汇总分析，原始答案和导出数据最长保存 ${escapeHtml(consent.retentionDays)} 天。</li>
          <li><strong>最小化处理</strong>不收集姓名、手机号、身份证或联系方式；仅使用短期匿名限流标识保护服务。</li>
          <li><strong>删除与联系</strong>开始后可在本页删除本次会话。研究联系人：${escapeHtml(consent.contact)}。</li>
        </ul>
        <label class="check-row"><input id="age-confirmed" type="checkbox"><span>我确认本人已满 ${escapeHtml(consent.ageMinimum)} 周岁。</span></label>
        <label class="check-row"><input id="consent-confirmed" type="checkbox"><span>我已阅读上述说明，并同意按所述方式处理本次问卷数据。</span></label>
        <div class="actions"><button class="primary-button" type="button" data-action="start">同意并开始</button></div>
      </section>`);
  }

  function stageLabel(stage) {
    const labels = { mainShape: "主形维度", adaptiveProfile: "画像追问", conflict: "冲突核验", quality: "质量核验" };
    return labels[stage] || "研究题目";
  }

  function renderQuestion() {
    const question = state.question;
    if (!question) {
      renderResult();
      return;
    }
    const answered = Number(question.progress?.answered || 0);
    const total = Number(question.progress?.total || 30);
    const percent = Math.max(0, Math.min(100, (answered / total) * 100));
    const answers = answerLabels.map((label, index) => `
      <button class="answer-button" type="button" data-answer="${index + 1}">
        <span class="answer-number">${index + 1}</span><span>${label}</span>
      </button>`).join("");
    const missing = question.naAllowed ? `<button class="answer-button na" type="button" data-answer="uncertain">不确定 / 不适用</button>` : "";
    setContent(`${header()}
      <section class="tool-panel question-panel">
        <div class="progress-row"><span>${stageLabel(question.stage)}</span><span>${answered + 1} / ${total}</span></div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${answered}"><div class="progress-fill" style="width:${percent}%"></div></div>
        <p class="question-meta">第 ${escapeHtml(question.number)} 题</p>
        <h2 class="question-text">${escapeHtml(question.text)}</h2>
        <div class="answer-list" aria-label="请选择一个答案">${answers}${missing}</div>
        <div class="question-footer"><span>请选择最贴近您近况的选项</span><button class="danger-button" type="button" data-action="withdraw">删除本次数据</button></div>
      </section>`);
    questionShownAt = Date.now();
  }

  function shapeName(entry, index) {
    if (typeof entry === "string") return entry;
    const names = { wood: "木形", fire: "火形", earth: "土形", metal: "金形", water: "水形" };
    return entry?.name || entry?.label || entry?.element || names[entry?.key] || `主形 ${index + 1}`;
  }

  function shapeScore(entry) {
    if (typeof entry === "number") return entry;
    return Number(entry?.score ?? entry?.value ?? 0);
  }

  function renderScores(result) {
    const scores = Array.isArray(result.shapeScores)
      ? result.shapeScores
      : Object.entries(result.shapeScores || {}).map(([key, score]) => ({ key, score }));
    if (!scores.length) return "";
    return `<div class="result-grid">${scores.slice(0, 5).map((entry, index) => `
      <div class="score-cell"><strong>${Math.round(shapeScore(entry))}</strong><span>${escapeHtml(shapeName(entry, index))}</span></div>`).join("")}</div>`;
  }

  function qualityText(result) {
    const quality = result.quality || {};
    const flags = Array.isArray(quality.flags) ? quality.flags : [];
    const message = quality.message ? `<p>${escapeHtml(quality.message)}</p>` : "";
    if (!flags.length) return `${message}<p>质量规则未发现额外提示。</p>`;
    return `${message}<ul class="quality-list">${flags.map((flag) => `<li>${escapeHtml(flag.label || flag.message || flag.code || String(flag))}</li>`).join("")}</ul>`;
  }

  function uncertaintyText(result) {
    const shapeConfidence = result.shapeConfidence || "未定";
    const profileConfidence = result.profileConfidence || "未定";
    const coverage = Number.isFinite(Number(result.profileCoverage)) ? `${Math.round(Number(result.profileCoverage) * 100)}%` : "未定";
    return `<p>主形证据：${escapeHtml(shapeConfidence)}；画像置信度：${escapeHtml(profileConfidence)}；画像覆盖度：${escapeHtml(coverage)}。</p><p class="muted">这些是本研究内部的描述性指标，不代表经过临床验证的概率。</p>`;
  }

  function renderResult() {
    const result = state?.result;
    if (!result) {
      renderError("会话状态无法恢复", "未收到完整结果。请勿重新填写，稍后可通过原二维码重新进入以恢复会话。", true);
      return;
    }
    const sufficient = result.typeStatus === "research_candidate" && result.candidateType;
    const profile = result.profile;
    const qualityClass = result.quality?.status === "caution" ? "caution" : "";
    const candidate = sufficient
      ? `<p><strong>研究候选：</strong>${escapeHtml(profile?.name || result.candidateType)}</p>${profile?.oneSentence ? `<p>${escapeHtml(profile.oneSentence)}</p>` : ""}`
      : "<p>本次结果的证据不足以输出具体二十五人候选。五主形连续分仍可作为本研究的描述性信息。</p>";
    const advice = sufficient && profile?.advice ? `<div class="result-block"><h3>研究性参考</h3><p>${escapeHtml(profile.advice)}</p></div>` : "";
    setContent(`${header()}
      <section class="tool-panel result-panel">
        <p class="status-tag ${qualityClass}">${sufficient ? "研究候选结果" : "证据不足"}</p>
        <h2>本次答卷已完成</h2>
        <p class="intro-copy">以下内容仅用于本研究的维度性描述，不能替代医学、心理或其他专业评估。</p>
        ${renderScores(result)}
        <div class="result-block"><h3>不确定性</h3>${uncertaintyText(result)}</div>
        <div class="result-block"><h3>研究解释</h3>${candidate}</div>
        ${advice}
        <div class="result-block"><h3>答卷质量</h3>${qualityText(result)}</div>
        <div class="actions"><button class="danger-button" type="button" data-action="withdraw">删除本次数据</button></div>
      </section>`);
  }

  function renderState() {
    if (!state) return renderConsent();
    if (state.result || state.status === "completed") return renderResult();
    return renderQuestion();
  }

  async function restoreSession() {
    const id = savedSessionId();
    if (!id) return false;
    try {
      state = await request(`/api/sessions/${encodeURIComponent(id)}/current`);
      renderState();
      return true;
    } catch (error) {
      clearSessionId();
      if (error.status !== 404) throw error;
      return false;
    }
  }

  async function startSession() {
    const age = document.querySelector("#age-confirmed")?.checked;
    const consent = document.querySelector("#consent-confirmed")?.checked;
    if (!age || !consent) {
      renderError("需要完成参与确认", "请确认已满法定年龄并同意数据处理说明后再开始。", false);
      return;
    }
    const button = document.querySelector('[data-action="start"]');
    if (button) button.disabled = true;
    try {
      state = await request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ageConfirmed: true, consent: true, consentVersion: bootstrap.consent.version }),
      });
      saveSessionId(state.sessionId);
      renderState();
    } catch (error) {
      renderError("无法开始问卷", messageFrom(error));
    }
  }

  async function submitAnswer(rawAnswer) {
    if (submitting || !state?.question) return;
    submitting = true;
    document.querySelectorAll("[data-answer]").forEach((button) => { button.disabled = true; });
    const durationMs = Math.max(0, Math.min(15 * 60 * 1000, Date.now() - questionShownAt));
    try {
      state = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: state.question.id,
          answer: /^\d+$/.test(String(rawAnswer)) ? Number(rawAnswer) : rawAnswer,
          durationMs,
          expectedRevision: state.revision,
        }),
      });
      saveSessionId(state.sessionId);
      renderState();
    } catch (error) {
      if (error.status === 409) {
        try {
          state = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/current`);
          renderState();
        } catch (reloadError) {
          renderError("答题状态需要恢复", messageFrom(reloadError));
        }
      } else {
        renderError("答案未提交", messageFrom(error));
      }
    } finally {
      submitting = false;
    }
  }

  async function withdraw() {
    if (!state?.sessionId) return;
    if (!window.confirm("确认删除本次问卷数据吗？删除后无法恢复。")) return;
    const buttons = document.querySelectorAll('[data-action="withdraw"]');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await request(`/api/sessions/${encodeURIComponent(state.sessionId)}`, { method: "DELETE" });
      state = null;
      clearSessionId();
      renderConsent();
    } catch (error) {
      renderError("无法删除本次数据", messageFrom(error));
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.action === "start") startSession();
    if (button.dataset.action === "withdraw") withdraw();
    if (button.dataset.action === "retry") initialize();
    if (button.dataset.answer !== undefined) submitAnswer(button.dataset.answer);
  });

  async function initialize() {
    setContent('<section class="tool-panel loading-panel" aria-label="正在加载问卷"><span class="loader" aria-hidden="true"></span><p>正在验证问卷入口…</p></section>');
    try {
      bootstrap = await request("/api/bootstrap", { headers: { "X-YY25-CSRF": "" } });
      if (!(await restoreSession())) renderConsent();
    } catch (error) {
      const text = error.status === 404
        ? "此页面需要从有效的问卷二维码进入，或活动链接已失效。"
        : messageFrom(error);
      renderError("无法进入问卷", text, error.status !== 404);
    }
  }

  initialize();
})();

