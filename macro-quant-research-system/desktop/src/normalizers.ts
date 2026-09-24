import type { Candle } from './components/ForecastChart';
import { finiteNumber } from './format';

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric) && Math.abs(numeric) > 1_000_000_000) {
      const millis = Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
      const date = new Date(millis);
      return Number.isNaN(date.valueOf()) ? null : date.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  return null;
}

/** Accepts the internal candle contract and canonical collector field aliases. */
export function normalizeCandles(value: unknown): Candle[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const ts = toIsoTimestamp(row.ts ?? row.ts_ms ?? row.timestamp ?? row.open_time_ms);
    const close = finiteNumber(row.close ?? row.c);
    if (!ts || close === null) return [];
    const closedValue = row.confirmed ?? row.closed ?? row.confirm;
    const confirmed = closedValue === undefined
      ? undefined
      : closedValue === true || closedValue === 1 || closedValue === '1' || closedValue === 'true';
    return [{
      ts,
      open: finiteNumber(row.open ?? row.o) ?? undefined,
      high: finiteNumber(row.high ?? row.h) ?? undefined,
      low: finiteNumber(row.low ?? row.l) ?? undefined,
      close,
      volume: finiteNumber(row.volume ?? row.volume_base ?? row.volume_raw) ?? undefined,
      confirmed,
    }];
  });
}

