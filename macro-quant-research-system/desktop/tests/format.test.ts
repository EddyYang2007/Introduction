import { describe, expect, it } from 'vitest';
import { finiteNumber, formatPercent, formatPrice, scenarioTargetList, stringList } from '../src/format';

describe('strict display formatters', () => {
  it('does not turn missing or invalid values into zero', () => {
    expect(finiteNumber(undefined)).toBeNull();
    expect(finiteNumber('')).toBeNull();
    expect(finiteNumber('not-a-number')).toBeNull();
    expect(formatPrice(undefined)).toBe('—');
    expect(formatPercent(null)).toBe('—');
  });

  it('formats explicit backend values only', () => {
    expect(finiteNumber('123.5')).toBe(123.5);
    expect(formatPercent(0.625)).toContain('62.5');
  });

  it('parses JSON evidence fields without executing them', () => {
    expect(stringList('["证据 A","证据 B"]')).toEqual(['证据 A', '证据 B']);
    expect(stringList('普通文本')).toEqual(['普通文本']);
  });

  it('formats manual scenario target ranges for non-technical display', () => {
    expect(scenarioTargetList({ BTC: { low: 68000, high: 85000, center: 78000 } })).toEqual([
      'BTC：68,000 - 85,000（中枢 78,000）',
    ]);
    expect(scenarioTargetList({ BRENT: { low: 105, high: null } })).toEqual(['BRENT：105 以上']);
  });
});

