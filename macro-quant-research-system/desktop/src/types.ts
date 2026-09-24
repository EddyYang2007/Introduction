export type Instrument = 'BTC-USDT' | 'ETH-USDT';
export type Horizon = 1 | 2 | 3 | 5 | 7 | 30;

export interface Forecast {
  forecast_id: string;
  instrument: string;
  publish_ts: string;
  cutoff_ts: string;
  target_ts: string;
  horizon: number;
  probability_up: number | null;
  probability_down: number | null;
  median_price: number | null;
  interval_80_low: number | null;
  interval_80_high: number | null;
  interval_95_low: number | null;
  interval_95_high: number | null;
  macro_regime_json?: unknown;
  market_regime_json?: unknown;
  drivers_json?: unknown;
  counterforces_json?: unknown;
  invalidation_json?: unknown;
  evidence_json?: unknown;
  data_gaps_json?: unknown;
  sample_status?: string | null;
  model_version?: string | null;
  scenario_version?: string | null;
  current_price?: number | null;
  prediction_mode?: 'baseline_only' | 'macro_active' | 'blocked' | string | null;
  prediction_mode_label?: string | null;
  forecast_scope?: 'remaining_session' | 'future_close' | string | null;
  data_asof?: string | null;
  target_date?: string | null;
  feature_version?: string | null;
  train_end_date?: string | null;
  close?: { q10?: number | null; q50?: number | null; q90?: number | null } | null;
  high?: { q10?: number | null; q50?: number | null; q90?: number | null } | null;
  low?: { q10?: number | null; q50?: number | null; q90?: number | null } | null;
  drivers?: unknown;
  counterforces?: unknown;
  invalidation_conditions?: unknown;
  data_gaps?: unknown;
}

export interface MarketStatus {
  status?: string;
  status_label?: string;
  real_market_connected?: boolean;
  realtime_status?: 'connected' | 'disconnected' | 'not_monitored' | string;
  realtime?: { status?: string; connected?: boolean; last_event_at?: string | null; transport?: string | null };
  snapshot_kind?: string;
  snapshot_status?: 'fresh' | 'stale' | 'missing' | string;
  freshness_status?: 'fresh' | 'stale' | 'missing' | 'invalid' | string;
  collection_status?: 'ok' | 'partial' | 'degraded' | string;
  display_label?: string;
  checked_at?: string;
  snapshot_age_seconds?: number | null;
  mode?: string;
  source?: string;
  primary_source?: string;
  cross_check_source?: string;
  last_event_ts?: string;
  last_update?: string;
  instruments?: Record<string, unknown> | unknown[];
  latest_prices?: Record<string, number>;
  degraded_reason?: string | null;
  message?: string;
  uptime_seconds?: number;
}

export interface Scenario {
  scenario_id?: string;
  id?: string;
  title?: string;
  name?: string;
  status?: string;
  instrument?: string;
  probability?: number | null;
  author_probability?: number | null;
  calibrated?: boolean;
  conditions?: unknown;
  transmission_chain?: unknown;
  targets?: unknown;
  invalidation?: unknown;
  evidence?: unknown;
  source_relative_path?: string;
  source_location?: string;
  execution_enabled?: boolean;
  effective_from?: string;
  effective_to?: string;
  version?: string;
}

export interface EvidenceEvent {
  event_id?: string;
  id?: string;
  title?: string;
  event_type?: string;
  category?: string;
  source?: string;
  source_url?: string;
  source_ts?: string;
  publish_ts?: string;
  known_at?: string;
  status?: string;
  quality?: string;
  summary?: string;
  late_arrival?: boolean;
  included_in_0810?: boolean;
}

export interface Revision {
  revision_id?: string;
  id?: string;
  created_at?: string;
  effective_at?: string;
  entity?: string;
  from_version?: string;
  to_version?: string;
  reason?: string;
  status?: string;
  validation_status?: string;
  changes?: unknown;
  failure_reason?: string | null;
}

export interface AuditStatus {
  software_status?: string;
  software_runtime_passed?: boolean;
  performance_status?: string;
  prediction_performance_observed?: boolean;
  advantage_status?: string;
  relative_advantage_verified?: boolean;
  sample_status?: string;
  effective_sample_size?: number;
  metrics?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  integrity?: Record<string, unknown>;
  updated_at?: string;
  notes?: unknown;
}

export interface AuditReport {
  name?: string;
  report_id?: string;
  title?: string;
  kind?: string;
  generated_at?: string;
  status?: string;
  period_start?: string;
  period_end?: string;
}

export interface PublicSettings {
  revision_call_limit?: number;
  local_llm_enabled?: boolean;
  local_llm_base_url?: string;
  local_llm_model?: string;
  // Backward-compatible read aliases; writes use the canonical fields above.
  model_service_url?: string;
  model_name?: string;
  temperature?: number;
  timeout_seconds?: number;
  max_daily_revisions?: number;
  provider?: string;
  structured_probe_status?: string;
}

export interface ProbeResult {
  ok?: boolean;
  schema_valid?: boolean;
  model?: string;
  latency_ms?: number;
  error?: string | null;
  checked_at?: string;
}

export interface CredentialStatus {
  configured?: boolean;
  provider?: string;
  storage?: string;
  credential_name?: string;
  updated_at?: string;
}

