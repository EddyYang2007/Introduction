import { describe, expect, it } from 'vitest';
import { normalizeCandles } from '../src/normalizers';

describe('market candle compatibility', () => {
  it('accepts internal candle fields', () => {
    const result = normalizeCandles([{ ts: '2026-09-20T00:00:00Z', close: 123, confirmed: true }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ close: 123, confirmed: true });
  });

  it('accepts canonical collector aliases without inventing values', () => {
    const result = normalizeCandles([{ ts_ms: 1_795_305_600_000, o: '10', h: '12', l: '9', c: '11', volume_base: '20', closed: true }]);
    expect(result[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 11, volume: 20, confirmed: true });
  });

  it('drops rows lacking a real timestamp or close', () => {
    expect(normalizeCandles([{ ts: 'bad', close: 1 }, { ts: '2026-09-20T00:00:00Z' }])).toEqual([]);
  });
});

