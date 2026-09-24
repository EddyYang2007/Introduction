import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { exportReport, getApiBaseUrl, requestApi, setApiBaseUrl, unwrapItems, unwrapObject } from './api';
import { ForecastChart, type Candle } from './components/ForecastChart';
import { finiteNumber, formatDateTime, formatPercent, formatPrice, scenarioTargetList, statusTone, stringList } from './format';
import { useApiResource } from './hooks/useApiResource';
import { normalizeCandles } from './normalizers';
import type {
  AuditReport,
  AuditStatus,
  CredentialStatus,
  EvidenceEvent,
  Forecast,
  Instrument,
  MarketStatus,
  PublicSettings,
  ProbeResult,
  Revision,
  Scenario,
} from './types';

type PageId = 'overview' | 'chart' | 'scenarios' | 'events' | 'revisions' | 'audit' | 'settings';

const pages: Array<{ id: PageId; label: string; caption: string; icon: string }> = [
  { id: 'overview', label: '预测总览', caption: '1 / 7 / 30 日', icon: 'overview' },
  { id: 'chart', label: '日线与区间', caption: '80% / 95%', icon: 'chart' },
  { id: 'scenarios', label: '长期剧本', caption: '条件与证伪', icon: 'scenario' },
  { id: 'events', label: '事实与事件', caption: '北京时间', icon: 'calendar' },
  { id: 'revisions', label: '修订历史', caption: '只追加不覆盖', icon: 'history' },
  { id: 'audit', label: '审计报告', caption: '证据与结算', icon: 'audit' },
  { id: 'settings', label: '接口设置', caption: '本地服务', icon: 'settings' },
];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    chart: <><path d="M3 3v18h18"/><path d="m6 16 4-5 4 3 6-8"/></>,
    scenario: <><path d="M12 3v5"/><path d="M5 8h14"/><path d="M5 8v5"/><path d="M19 8v5"/><rect x="2" y="13" width="6" height="7" rx="2"/><rect x="16" y="13" width="6" height="7" rx="2"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    audit: <><path d="M7 3h10l4 4v14H3V3h4Z"/><path d="M14 3v5h5M7 13l3 3 7-7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></>,
    replay: <><path d="M4 12a8 8 0 1 0 3-6.2L4 9"/><path d="M4 4v5h5M10 8l6 4-6 4Z"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/></>,
    close: <><path d="M5 5l14 14M19 5 5 19"/></>,
    shield: <><path d="M12 3 4 6v5c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.overview}</svg>;
}

function StatusPill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'muted' | 'info' }) {
  return <span className={`status-pill ${tone}`}><i />{children}</span>;
}

function SectionTitle({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: ReactNode }) {
  return <div className="section-title"><div><span>{eyebrow}</span><h2>{title}</h2></div>{aside}</div>;
}

function EmptyState({ title, detail, error }: { title: string; detail: string; error?: string }) {
  return <div className={`empty-state ${error ? 'error' : ''}`} role="status"><span className="empty-mark">{error ? '!' : '∅'}</span><strong>{title}</strong><p>{error ?? detail}</p></div>;
}

function ErrorStrip({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="error-strip"><strong>降级：</strong>{error}。已保留最后一次成功内容（如有），未生成替代数据。</div>;
}

function JsonList({ value, empty = '后端未提供' }: { value: unknown; empty?: string }) {
  const items = stringList(value);
  if (!items.length) return <span className="muted-text">{empty}</span>;
  return <ul className="clean-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>;
}

function forecastsFrom(value: unknown): Forecast[] {
  const items = unwrapItems<Forecast>(value);
  if (items.length) return items;
  const object = unwrapObject<Record<string, unknown>>(value);
  if (!object) return [];
  if ('forecast_id' in object) return [object as unknown as Forecast];
  if (object.forecast && typeof object.forecast === 'object') return [object.forecast as Forecast];
  return [];
}

function ForecastCard({ forecast, onReplay }: { forecast: Forecast; onReplay: (forecast: Forecast) => void }) {
  const up = finiteNumber(forecast.probability_up);
  const down = finiteNumber(forecast.probability_down);
  const dominant = up !== null && down !== null ? (up >= down ? 'up' : 'down') : 'unknown';
  return (
    <article className="forecast-card">
      <div className="forecast-card-head">
        <div><span className="horizon-kicker">目标期限</span><strong>{forecast.forecast_scope === 'remaining_session' ? '当日剩余时段' : `${forecast.horizon} 日直接预测`}</strong></div>
        <div className="forecast-card-status">
          <StatusPill tone={forecast.prediction_mode === 'macro_active' ? 'good' : forecast.prediction_mode === 'blocked' ? 'bad' : 'warn'}>{forecast.prediction_mode_label || (forecast.prediction_mode === 'macro_active' ? '宏观激活' : '仅历史分布基准')}</StatusPill>
          <StatusPill tone={statusTone(forecast.sample_status)}>{forecast.sample_status || '样本状态未报告'}</StatusPill>
        </div>
      </div>
      <div className="probability-row">
        <div className={dominant === 'up' ? 'dominant' : ''}><span>上涨概率</span><strong className="up-number">{formatPercent(up)}</strong></div>
        <div className={dominant === 'down' ? 'dominant' : ''}><span>下跌概率</span><strong className="down-number">{formatPercent(down)}</strong></div>
      </div>
      <div className="price-block">
        <span>目标日收盘中位数</span>
        <strong>{formatPrice(forecast.median_price)}</strong>
      </div>
      <div className="interval-stack">
        <div><span>80% 区间</span><b>{formatPrice(forecast.interval_80_low)}</b><i>—</i><b>{formatPrice(forecast.interval_80_high)}</b></div>
        <div><span>95% 区间</span><b>{finiteNumber(forecast.interval_95_low) === null ? '未提供' : formatPrice(forecast.interval_95_low)}</b><i>—</i><b>{finiteNumber(forecast.interval_95_high) === null ? '未提供' : formatPrice(forecast.interval_95_high)}</b></div>
      </div>
      <dl className="forecast-meta">
        <div><dt>目标时间</dt><dd>{formatDateTime(forecast.target_ts)}</dd></div>
        <div><dt>模型版本</dt><dd>{forecast.model_version || '未报告'}</dd></div>
        <div><dt>数据截至</dt><dd>{formatDateTime(forecast.data_asof || forecast.cutoff_ts)}</dd></div>
      </dl>
      <button className="text-button" onClick={() => onReplay(forecast)} disabled={!forecast.forecast_id}><Icon name="replay" size={17} />逐条预测重放</button>
    </article>
  );
}

function OverviewPage({ instrument, forecasts, loading, error, onReplay }: { instrument: Instrument; forecasts: Forecast[]; loading: boolean; error?: string; onReplay: (forecast: Forecast) => void }) {
  const ordered = [...forecasts].sort((a, b) => a.horizon - b.horizon);
  const featured = ordered[0];
  const modes = new Set(ordered.map((item) => item.prediction_mode || 'baseline_only'));
  const predictionMode = modes.size === 1 ? [...modes][0] : ordered.length ? 'baseline_only' : 'blocked';
  const predictionModeLabel = featured?.prediction_mode_label || (predictionMode === 'macro_active' ? '宏观激活' : predictionMode === 'blocked' ? '阻断' : '仅历史分布基准');
  return <div className="page-stack">
    <section className="hero-panel">
      <div>
        <span className="eyebrow">正式预测 · 只读封存</span>
        <h1>{instrument.replace('-', ' / ')} 日线预测</h1>
        <p>1 / 2 / 3 / 5 / 7 日均为从截点直接预测，不递归使用前一日预测；日内剩余时段另行封存。</p>
      </div>
      <div className="hero-meta">
        <div><span>最新发布时间</span><strong>{formatDateTime(featured?.publish_ts)}</strong></div>
        <div><span>快照截止</span><strong>{formatDateTime(featured?.cutoff_ts)}</strong></div>
        <div><span>预测 ID</span><strong className="mono">{featured?.forecast_id || '—'}</strong></div>
      </div>
    </section>
    <ErrorStrip error={error} />
    <div className={`prediction-mode-banner ${predictionMode}`} role="status"><strong>{predictionModeLabel}</strong><span>{predictionMode === 'baseline_only' ? '当前仅展示历史分布基准，不代表完整宏观预测。' : predictionMode === 'blocked' ? '宏观或行情前置条件未满足，正式预测分支已阻断。' : '宏观层满足当前 PIT 闸门；仍需以前瞻结算验证表现。'}</span></div>
    {ordered.length ? <section className="forecast-grid">{ordered.map((forecast) => <ForecastCard key={forecast.forecast_id || `${forecast.instrument}-${forecast.horizon}`} forecast={forecast} onReplay={onReplay} />)}</section> : <EmptyState title={loading ? '正在读取封存预测' : '暂无正式预测'} detail="后端未返回该币种的封存预测。系统不会用示例数值填充。" error={loading ? undefined : error} />}
    {featured && <section className="two-column">
      <article className="panel"><SectionTitle eyebrow="解释层" title="主要驱动与反向因素" /><div className="split-list"><div><h3>主要驱动</h3><JsonList value={featured.drivers ?? featured.drivers_json} /></div><div><h3>反向因素</h3><JsonList value={featured.counterforces ?? featured.counterforces_json} /></div></div></article>
      <article className="panel"><SectionTitle eyebrow="证据边界" title="失效条件与数据缺口" /><div className="split-list"><div><h3>失效条件</h3><JsonList value={featured.invalidation_conditions ?? featured.invalidation_json} /></div><div><h3>数据缺口</h3><JsonList value={featured.data_gaps ?? featured.data_gaps_json} empty="未报告缺口" /></div></div></article>
    </section>}
  </div>;
}

function ChartPage({ instrument, latestForecasts }: { instrument: Instrument; latestForecasts: Forecast[] }) {
  const candles = useApiResource<unknown>(`/api/v1/market/candles?instrument=${instrument}&limit=180`, 60_000);
  const history = useApiResource<unknown>(`/api/v1/forecasts/v2/history?instrument=${instrument}&scope=future_close`, 60_000);
  const candleObject = unwrapObject<{ candles?: Candle[] }>(candles.data);
  const candleItems = normalizeCandles(candleObject?.candles ?? unwrapItems<Candle>(candles.data));
  const historyItems = forecastsFrom(history.data);
  const byHorizon = new Map<number, Forecast>();
  for (const forecast of [...historyItems, ...latestForecasts]) {
    if (forecast.instrument === instrument || !forecast.instrument) byHorizon.set(forecast.horizon, forecast);
  }
  const chartForecasts = [...byHorizon.values()].sort((a, b) => a.horizon - b.horizon);
  const source = unwrapObject<Record<string, unknown>>(candles.data)?.source;
  return <div className="page-stack">
    <section className="panel chart-panel">
      <SectionTitle eyebrow="Point-in-time" title={`${instrument} 已确认日线与预测扇形`} aside={<div className="title-actions"><StatusPill tone={source ? 'good' : 'warn'}>来源 {typeof source === 'string' ? source : '未报告'}</StatusPill><button className="icon-button" onClick={() => { void candles.refresh(); void history.refresh(); }} aria-label="刷新图表"><Icon name="refresh" size={18} /></button></div>} />
      <ErrorStrip error={candles.error || history.error} />
      <ForecastChart candles={candleItems} forecasts={chartForecasts} />
    </section>
    <section className="metric-note-grid">
      <article><span>数据口径</span><strong>UTC 已收盘日线</strong><p>界面时间转换为北京时间；未收盘 K 线不得进入。</p></article>
      <article><span>区间口径</span><strong>目标日收盘价</strong><p>80% 是 q10–q90；95% 仅在模型真实提供时展示，不做伪造。</p></article>
      <article><span>跨交易所</span><strong>分别记录</strong><p>主行情与交叉检查不静默拼接；来源缺失保持缺失。</p></article>
    </section>
  </div>;
}

function ScenariosPage({ instrument }: { instrument: Instrument }) {
  const resource = useApiResource<unknown>(`/api/v1/scenarios?instrument=${instrument}`, 60_000);
  const scenarios = unwrapItems<Scenario>(resource.data);
  return <div className="page-stack">
    <SectionTitle eyebrow="长期约束" title="长期剧本与传导条件" aside={<StatusPill tone="info">剧本不是每日必达价格</StatusPill>} />
    <ErrorStrip error={resource.error} />
    {scenarios.length ? <section className="scenario-grid">{scenarios.map((scenario, index) => <article className="scenario-card" key={scenario.scenario_id || scenario.id || index}>
      <div className="scenario-head"><span className="scenario-index">{String(index + 1).padStart(2, '0')}</span><StatusPill tone={statusTone(scenario.status)}>{scenario.status === 'candidate_unvalidated' ? '候选，未验证' : scenario.status || '状态未报告'}</StatusPill></div>
      <h3>{scenario.title || scenario.name || '未命名剧本'}</h3>
      <div className="scenario-probability"><span>模型校准概率</span><strong>{scenario.calibrated ? formatPercent(scenario.probability) : '未校准'}</strong></div>
      <div className="scenario-probability"><span>作者主观概率</span><strong>{scenario.author_probability == null ? '未提供' : formatPercent(scenario.author_probability)}</strong></div>
      <div className="scenario-section"><h4>成立条件</h4><JsonList value={scenario.conditions} /></div>
      <div className="scenario-section"><h4>传导链</h4><JsonList value={scenario.transmission_chain} /></div>
      <div className="scenario-section"><h4>作者目标区间</h4><JsonList value={scenarioTargetList(scenario.targets)} empty="未提供目标区间" /></div>
      <div className="scenario-section danger"><h4>证伪条件</h4><JsonList value={scenario.invalidation} /></div>
      <footer><span>{scenario.source_relative_path || scenario.version || '版本未报告'}{scenario.source_location ? ` · ${scenario.source_location}` : ''}</span><span>{formatDateTime(scenario.effective_from)} → {formatDateTime(scenario.effective_to)}</span></footer>
    </article>)}</section> : <EmptyState title={resource.loading ? '正在读取长期剧本' : '暂无剧本'} detail="未返回可追溯的长期剧本。" error={resource.loading ? undefined : resource.error} />}
  </div>;
}

function EventsPage() {
  const resource = useApiResource<unknown>('/api/v1/events?limit=200', 60_000);
  const events = unwrapItems<EvidenceEvent>(resource.data).sort((a, b) => String(b.known_at || b.publish_ts || b.source_ts || '').localeCompare(String(a.known_at || a.publish_ts || a.source_ts || '')));
  const grouped = useMemo(() => {
    const groups = new Map<string, EvidenceEvent[]>();
    for (const event of events) {
      const raw = event.known_at || event.publish_ts || event.source_ts;
      const date = raw ? new Date(raw) : null;
      const key = date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(date) : '时间未报告';
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    return [...groups.entries()];
  }, [events]);
  return <div className="page-stack">
    <SectionTitle eyebrow="事实层" title="事实与事件日历" aside={<StatusPill tone="muted">全部时间按北京时间展示</StatusPill>} />
    <ErrorStrip error={resource.error} />
    {grouped.length ? <section className="timeline">{grouped.map(([date, items]) => <div className="timeline-day" key={date}><div className="timeline-date"><span>{date}</span><b>{items.length} 条</b></div><div className="timeline-items">{items.map((event, index) => <article key={event.event_id || event.id || index}>
      <div className="timeline-marker" />
      <div className="event-head"><div><span>{formatDateTime(event.known_at || event.publish_ts || event.source_ts)}</span><h3>{event.title || event.summary || event.event_type || '未命名事件'}</h3></div><StatusPill tone={statusTone(event.quality || event.status)}>{event.quality || event.status || '质量未报告'}</StatusPill></div>
      <p>{event.summary && event.summary !== event.title ? event.summary : '后端未提供摘要'}</p>
      <footer><span>类型：{event.event_type || event.category || '未分类'}</span><span>来源：{event.source || '未报告'}</span>{event.late_arrival !== undefined && <span className={event.late_arrival ? 'text-warn' : ''}>{event.late_arrival ? '迟到记录' : '按时可见'}</span>}{event.included_in_0810 !== undefined && <span>{event.included_in_0810 ? '纳入 08:10 快照' : '未纳入正式快照'}</span>}</footer>
    </article>)}</div></div>)}</section> : <EmptyState title={resource.loading ? '正在读取事件' : '暂无事实与事件'} detail="后端未返回事件记录。" error={resource.loading ? undefined : resource.error} />}
  </div>;
}

function RevisionsPage() {
  const resource = useApiResource<unknown>('/api/v1/revisions?limit=200', 60_000);
  const revisions = unwrapItems<Revision>(resource.data);
  return <div className="page-stack">
    <SectionTitle eyebrow="Append-only" title="修订历史" aside={<StatusPill tone="good">旧预测不可覆盖</StatusPill>} />
    <ErrorStrip error={resource.error} />
    {revisions.length ? <section className="revision-table" role="table" aria-label="修订历史"><div className="revision-row revision-header" role="row"><span>生效时间</span><span>对象 / 版本</span><span>原因与变更</span><span>校验</span></div>{revisions.map((revision, index) => <div className="revision-row" role="row" key={revision.revision_id || revision.id || index}>
      <div><strong>{formatDateTime(revision.effective_at || revision.created_at)}</strong><small className="mono">{revision.revision_id || revision.id || 'ID 未报告'}</small></div>
      <div><strong>{revision.entity || '对象未报告'}</strong><small>{revision.from_version || '—'} → {revision.to_version || '—'}</small></div>
      <div><strong>{revision.reason || '原因未报告'}</strong><JsonList value={revision.changes} empty="变更明细未报告" /></div>
      <div><StatusPill tone={statusTone(revision.validation_status || revision.status)}>{revision.validation_status || revision.status || '未报告'}</StatusPill>{revision.failure_reason && <small className="text-bad">{revision.failure_reason}</small>}</div>
    </div>)}</section> : <EmptyState title={resource.loading ? '正在读取修订历史' : '暂无修订记录'} detail="尚无可展示的追加式修订。" error={resource.loading ? undefined : resource.error} />}
  </div>;
}

function auditConclusion(value: boolean | undefined, status: string | undefined, negative: string): { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  if (value === true) return { text: status || '已通过', tone: 'good' };
  if (value === false) return { text: status || negative, tone: 'warn' };
  if (status) return { text: status, tone: statusTone(status) };
  return { text: '后端未报告', tone: 'muted' };
}

function AuditPage() {
  const statusResource = useApiResource<unknown>('/api/v1/audit/status', 60_000);
  const reportsResource = useApiResource<unknown>('/api/v1/reports', 60_000);
  const status = unwrapObject<AuditStatus>(statusResource.data) ?? {};
  const reports = unwrapItems<AuditReport>(reportsResource.data);
  const [exporting, setExporting] = useState<string>();
  const [exportMessage, setExportMessage] = useState<string>();
  const software = auditConclusion(status.software_runtime_passed, status.software_status, '未通过');
  const performance = auditConclusion(status.prediction_performance_observed, status.performance_status, '尚未形成到期观察');
  const advantage = auditConclusion(status.relative_advantage_verified, status.advantage_status, '尚未验证相对基准优势');

  async function doExport(report: AuditReport) {
    const name = report.name || report.report_id;
    if (!name) return;
    setExporting(name);
    setExportMessage(undefined);
    const result = await requestApi<unknown>({ path: `/api/v1/reports/${encodeURIComponent(name)}/export` });
    if (!result.ok) {
      setExportMessage(`导出失败：${result.error || `HTTP ${result.status}`}`);
      setExporting(undefined);
      return;
    }
    const payload = result.data;
    const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
    const content = typeof payload === 'string' ? payload : typeof object?.content === 'string' ? object.content : JSON.stringify(payload, null, 2);
    const saved = await exportReport({ suggestedName: String(object?.filename || report.title || name).replace(/\.(md|json)$/i, ''), content, format: typeof payload === 'string' || typeof object?.content === 'string' ? 'md' : 'json' });
    setExportMessage(saved.ok ? `已导出：${saved.path}` : saved.canceled ? '已取消导出' : `导出失败：${saved.error}`);
    setExporting(undefined);
  }

  return <div className="page-stack">
    <SectionTitle eyebrow="三层结论" title="审计状态与报告" aside={<span className="updated-at">更新 {formatDateTime(status.updated_at)}</span>} />
    <ErrorStrip error={statusResource.error || reportsResource.error} />
    <section className="audit-conclusions">
      <article><span>01</span><h3>软件运行通过</h3><StatusPill tone={software.tone}>{software.text}</StatusPill><p>只说明链路、数据契约和运行测试，不代表预测有效。</p></article>
      <article><span>02</span><h3>预测表现已观察</h3><StatusPill tone={performance.tone}>{performance.text}</StatusPill><p>需等待目标日到期并保留失败、暂停与漏报记录。</p></article>
      <article><span>03</span><h3>相对基准优势</h3><StatusPill tone={advantage.tone}>{advantage.text}</StatusPill><p>必须以样本外指标和置信区间证明，不由解释文本替代。</p></article>
    </section>
    <section className="two-column audit-details">
      <article className="panel"><SectionTitle eyebrow="样本与指标" title="前瞻审计摘要" /><dl className="audit-kv"><div><dt>样本状态</dt><dd>{status.sample_status || '未报告'}</dd></div><div><dt>有效样本量</dt><dd>{finiteNumber(status.effective_sample_size) ?? '未报告'}</dd></div></dl><h3>指标</h3><JsonList value={status.metrics} /><h3>区间覆盖</h3><JsonList value={status.coverage} /></article>
      <article className="panel"><SectionTitle eyebrow="不可篡改" title="完整性证据" /><JsonList value={status.integrity} /><h3>审计备注</h3><JsonList value={status.notes} /></article>
    </section>
    <section className="panel">
      <SectionTitle eyebrow="可复核产物" title="报告导出" aside={exportMessage && <span className="action-message">{exportMessage}</span>} />
      {reports.length ? <div className="report-list">{reports.map((report, index) => { const id = report.name || report.report_id || String(index); return <article key={id}><div><StatusPill tone={statusTone(report.status)}>{report.status || '状态未报告'}</StatusPill><h3>{report.title || report.name || report.report_id || '未命名报告'}</h3><p>{report.kind || '类型未报告'} · {formatDateTime(report.generated_at)}</p></div><button className="secondary-button" disabled={exporting === id} onClick={() => void doExport(report)}><Icon name="download" size={17} />{exporting === id ? '读取中…' : '导出'}</button></article>; })}</div> : <EmptyState title={reportsResource.loading ? '正在读取报告' : '暂无可导出报告'} detail="报告必须由后端基于真实审计记录生成。" error={reportsResource.loading ? undefined : reportsResource.error} />}
    </section>
  </div>;
}

function SettingsPage({ onConnectionChanged }: { onConnectionChanged: () => void }) {
  const settingsResource = useApiResource<unknown>('/api/v1/settings/public');
  const credentialsResource = useApiResource<unknown>('/api/v1/settings/credential-status');
  const settings = unwrapObject<PublicSettings>(settingsResource.data);
  const credentials = unwrapObject<CredentialStatus>(credentialsResource.data);
  const [baseUrl, setBaseUrlState] = useState('');
  const [form, setForm] = useState<PublicSettings>({});
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult>();

  useEffect(() => { void getApiBaseUrl().then(setBaseUrlState); }, []);
  useEffect(() => { if (settings) setForm(settings); }, [settingsResource.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(undefined);
    try {
      const normalized = await setApiBaseUrl(baseUrl);
      setBaseUrlState(normalized);
      const body: Record<string, unknown> = { local_llm_enabled: form.local_llm_enabled === true };
      const revisionLimit = finiteNumber(form.revision_call_limit ?? form.max_daily_revisions);
      const llmBaseUrl = form.local_llm_base_url || form.model_service_url;
      const llmModel = form.local_llm_model || form.model_name;
      if (revisionLimit !== null) body.revision_call_limit = revisionLimit;
      if (llmBaseUrl) body.local_llm_base_url = llmBaseUrl;
      if (llmModel) body.local_llm_model = llmModel;
      const result = await requestApi({ path: '/api/v1/settings/public', method: 'PATCH', body });
      if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`);
      setMessage('非密钥设置已由本地后端接受。接口根地址仅在本次桌面进程内生效。');
      await Promise.all([settingsResource.refresh(), credentialsResource.refresh()]);
      onConnectionChanged();
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    setProbeResult(undefined);
    setMessage(undefined);
    const result = await requestApi<unknown>({ path: '/api/v1/settings/probe', method: 'POST', body: { kind: 'llm' }, timeoutMs: 30_000 });
    if (result.ok) {
      const payload = unwrapObject<ProbeResult>(result.data);
      setProbeResult(payload ?? {});
      setMessage(payload?.ok && payload.schema_valid ? '真实推理已完成且结构化结果校验通过。' : `探针未通过：${payload?.error || '后端未确认 schema_valid'}`);
    } else {
      setMessage(`探针失败：${result.error || `HTTP ${result.status}`}`);
    }
    setProbing(false);
  }

  async function testConnection() {
    setMessage(undefined);
    try {
      const normalized = await setApiBaseUrl(baseUrl);
      setBaseUrlState(normalized);
      const result = await requestApi<Record<string, unknown>>({ path: '/api/v1/health', timeoutMs: 5000 });
      setMessage(result.ok ? `本地 FastAPI 响应正常（HTTP ${result.status}），这不等于模型推理或预测有效。` : `连接失败：${result.error || `HTTP ${result.status}`}`);
      onConnectionChanged();
    } catch (error) {
      setMessage(error instanceof Error ? `连接失败：${error.message}` : '连接失败');
    }
  }

  return <div className="page-stack settings-page">
    <SectionTitle eyebrow="Local only" title="接口与推理设置" aside={<StatusPill tone="good"><Icon name="shield" size={15} />不接交易账户</StatusPill>} />
    <ErrorStrip error={settingsResource.error || credentialsResource.error} />
    <form onSubmit={save} className="settings-form">
      <section className="panel"><SectionTitle eyebrow="桌面 → FastAPI" title="本地服务" /><label><span>FastAPI 根地址</span><input value={baseUrl} onChange={(event) => setBaseUrlState(event.target.value)} placeholder="http://127.0.0.1:8766" spellCheck={false} /><small>安全边界固定为明文 HTTP 的 127.0.0.1；localhost、局域网地址和公网地址均拒绝。</small></label><button type="button" className="secondary-button" onClick={() => void testConnection()}>测试后端健康</button></section>
      <section className="panel"><SectionTitle eyebrow="FastAPI → 本地模型" title="结构化推理（公开参数）" /><div className="form-grid"><label className="wide"><span>本地模型服务地址</span><input value={form.local_llm_base_url ?? form.model_service_url ?? ''} onChange={(event) => setForm({ ...form, local_llm_base_url: event.target.value })} placeholder="http://127.0.0.1:1234" spellCheck={false} /><small>后端同样只接受回环地址；桌面端不会直接连接模型服务。</small></label><label><span>模型名</span><input value={form.local_llm_model ?? form.model_name ?? ''} onChange={(event) => setForm({ ...form, local_llm_model: event.target.value })} placeholder="后端未配置" /></label><label><span>每日最大修订调用</span><input type="number" min="0" max="100" value={form.revision_call_limit ?? form.max_daily_revisions ?? ''} onChange={(event) => setForm({ ...form, revision_call_limit: event.target.value === '' ? undefined : Number(event.target.value) })} /></label><label className="toggle-label"><span>启用本地模型冷路径</span><input type="checkbox" checked={form.local_llm_enabled === true} onChange={(event) => setForm({ ...form, local_llm_enabled: event.target.checked })} /></label></div><div className="probe-status"><span>真实结构化推理</span><StatusPill tone={probeResult ? (probeResult.ok && probeResult.schema_valid ? 'good' : 'bad') : statusTone(form.structured_probe_status)}>{probeResult ? (probeResult.ok && probeResult.schema_valid ? '推理与 Schema 均通过' : probeResult.error || '未通过') : form.structured_probe_status || '本次尚未执行'}</StatusPill><p>{probeResult ? `模型 ${probeResult.model || '未报告'} · 延迟 ${finiteNumber(probeResult.latency_ms) ?? '未报告'} ms · ${formatDateTime(probeResult.checked_at)}` : '模型列表可用不算接入通过；点击探针会请求后端执行真实推理并校验结构化结果。'}</p><button type="button" className="secondary-button" disabled={probing} onClick={() => void runProbe()}>{probing ? '探针执行中…' : '执行真实推理探针'}</button></div></section>
      <section className="panel credential-panel"><SectionTitle eyebrow="Secret handling" title="密钥不经过桌面端" /><div className="credential-row"><div className="vault-icon"><Icon name="shield" size={28} /></div><div><strong>{credentials?.configured ? '后端凭据已配置' : '后端未报告可用凭据'}</strong><p>密钥由 FastAPI 后端通过 Windows Credential Manager 管理。桌面端不提供密钥输入框、不读取密钥，也不将密钥写入配置或日志。</p><dl><div><dt>提供方</dt><dd>{credentials?.provider || '未报告'}</dd></div><div><dt>存储</dt><dd>{credentials?.storage || 'Windows Credential Manager（要求）'}</dd></div><div><dt>凭据名称</dt><dd>{credentials?.credential_name || '不向桌面端公开'}</dd></div></dl></div></div></section>
      <div className="settings-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存非密钥设置'}</button>{message && <span className="action-message">{message}</span>}</div>
    </form>
  </div>;
}

function ReplayDialog({ forecast, onClose }: { forecast: Forecast; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<unknown>();
  useEffect(() => {
    let active = true;
    void requestApi({ path: `/api/v1/forecasts/${encodeURIComponent(forecast.forecast_id)}/replay`, method: 'POST', timeoutMs: 30_000 }).then((response) => {
      if (!active) return;
      setLoading(false);
      if (response.ok) setResult(response.data);
      else setError(response.error || `HTTP ${response.status}`);
    });
    return () => { active = false; };
  }, [forecast.forecast_id]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label="逐条预测重放"><header><div><span>FORECAST REPLAY</span><h2>逐条预测重放</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header><div className="replay-meta"><span>预测 ID</span><strong className="mono">{forecast.forecast_id}</strong><span>封存版本</span><strong>{forecast.model_version || '未报告'}</strong></div>{loading ? <EmptyState title="正在执行确定性重放" detail="后端正在读取封存输入、版本和阈值。" /> : error ? <EmptyState title="重放未完成" detail="不会生成替代结果。" error={error} /> : <><p className="replay-warning">下方为后端重放原始结果。客户端不改写、不美化一致性结论。</p><pre>{JSON.stringify(result, null, 2)}</pre></>}</section></div>;
}

export default function App() {
  const [page, setPage] = useState<PageId>('overview');
  const [instrument, setInstrument] = useState<Instrument>('BTC-USDT');
  const [replay, setReplay] = useState<Forecast>();
  const health = useApiResource<unknown>('/api/v1/health', 15_000);
  const market = useApiResource<unknown>('/api/v1/market/status', 15_000);
  const forecastResource = useApiResource<unknown>(`/api/v1/forecasts/v2/latest?instrument=${instrument}&scope=future_close`, 60_000);
  const forecasts = forecastsFrom(forecastResource.data).filter((item) => !item.instrument || item.instrument === instrument);
  const healthObject = unwrapObject<Record<string, unknown>>(health.data);
  const marketObject = unwrapObject<MarketStatus>(market.data);
  const healthStatus = healthObject?.status ?? healthObject?.health;
  const backendTone = health.error ? 'bad' : healthObject?.ok === true || /ok|healthy|pass|正常/i.test(String(healthStatus ?? '')) ? 'good' : health.data ? 'warn' : 'bad';
  // The daily collector does not monitor a live websocket. Do not infer a
  // realtime connection from the presence of a historical snapshot.
  const marketConnected = marketObject?.realtime?.connected === true || marketObject?.realtime_status === 'connected' || marketObject?.real_market_connected === true;
  const snapshotFresh = marketObject?.snapshot_status === 'fresh' || marketObject?.freshness_status === 'fresh';
  const marketTone = market.error
    ? 'bad'
    : marketConnected
      ? 'good'
      : marketObject?.collection_status === 'degraded' || marketObject?.collection_status === 'failed'
        ? 'warn'
        : snapshotFresh
          ? 'info'
          : marketObject
            ? 'warn'
            : 'bad';
  const marketLabel = market.error
    ? '不可用'
    : marketConnected
      ? '实时已连接'
      : `${snapshotFresh ? '日线快照新鲜' : String(marketObject?.freshness_status || marketObject?.status || '状态未知')}${marketObject?.collection_status === 'degraded' ? ' · 采集降级' : ''}`;
  const currentPage = pages.find((item) => item.id === page)!;

  function refreshGlobal() {
    void health.refresh();
    void market.refresh();
    void forecastResource.refresh();
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span>M</span></div><div><strong>宏观量化</strong><small>DAILY AUDIT</small></div></div>
      <div className="read-only-card"><Icon name="shield" size={18} /><div><strong>只读审计模式</strong><span>无账户 · 无交易 · 无下单</span></div></div>
      <nav aria-label="主导航">{pages.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.caption}</small></span></button>)}</nav>
      <div className="sidebar-footer"><span>数据截止与发布口径</span><strong>08:00 → 08:10 BJT</strong><small>盘中修订不覆盖正式预测</small></div>
    </aside>
    <main className="main-shell">
      <header className="topbar">
        <div className="page-identity"><span>{currentPage.caption}</span><strong>{currentPage.label}</strong></div>
        <div className="topbar-actions">
          <div className="instrument-switch" role="group" aria-label="币种选择"><button className={instrument === 'BTC-USDT' ? 'active' : ''} onClick={() => setInstrument('BTC-USDT')}>BTC</button><button className={instrument === 'ETH-USDT' ? 'active' : ''} onClick={() => setInstrument('ETH-USDT')}>ETH</button></div>
          <StatusPill tone={backendTone}>后端 {health.error ? '不可用' : String(healthStatus || '状态未知')}</StatusPill>
          <StatusPill tone={marketTone}>{marketObject?.status_label || marketObject?.display_label || '行情快照'} {marketLabel}</StatusPill>
          <button className={`icon-button ${health.refreshing || market.refreshing ? 'spinning' : ''}`} onClick={refreshGlobal} aria-label="刷新全局状态"><Icon name="refresh" size={18} /></button>
        </div>
      </header>
      {(health.error || market.error) && <div className="global-degraded"><strong>降级只读状态</strong><span>{health.error || market.error}</span><span>界面不会生成模拟预测或行情。</span></div>}
      <div className="content">
        {page === 'overview' && <OverviewPage instrument={instrument} forecasts={forecasts} loading={forecastResource.loading} error={forecastResource.error} onReplay={setReplay} />}
        {page === 'chart' && <ChartPage instrument={instrument} latestForecasts={forecasts} />}
        {page === 'scenarios' && <ScenariosPage instrument={instrument} />}
        {page === 'events' && <EventsPage />}
        {page === 'revisions' && <RevisionsPage />}
        {page === 'audit' && <AuditPage />}
        {page === 'settings' && <SettingsPage onConnectionChanged={refreshGlobal} />}
      </div>
    </main>
    {replay && <ReplayDialog forecast={replay} onClose={() => setReplay(undefined)} />}
  </div>;
}

