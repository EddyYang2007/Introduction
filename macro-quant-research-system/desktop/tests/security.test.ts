import { describe, expect, it } from 'vitest';
import {
  normalizeApiPath,
  normalizeLoopbackBaseUrl,
  isAllowedApiRequest,
  safeExportName,
} from '../shared/security';

describe('loopback-only API boundary', () => {
  it('accepts an explicit IPv4 loopback FastAPI root', () => {
    expect(normalizeLoopbackBaseUrl('http://127.0.0.1:8766/')).toBe('http://127.0.0.1:8766');
  });

  it.each([
    'https://127.0.0.1:8766',
    'http://localhost:8766',
    'http://0.0.0.0:8766',
    'http://192.168.1.20:8766',
    'https://example.com',
    'http://user:secret@127.0.0.1:8766',
    'http://127.0.0.1:8766/api/v1',
  ])('rejects non-compliant endpoint %s', (value) => {
    expect(() => normalizeLoopbackBaseUrl(value)).toThrow();
  });
});

describe('read-only route boundary', () => {
  it('allows audit, forecast replay and public settings paths', () => {
    expect(normalizeApiPath('/api/v1/audit/status')).toBe('/api/v1/audit/status');
    expect(normalizeApiPath('/api/v1/forecasts/f-1/replay')).toBe('/api/v1/forecasts/f-1/replay');
    expect(normalizeApiPath('/api/v1/settings/public')).toBe('/api/v1/settings/public');
  });

  it('uses an explicit method and endpoint allowlist', () => {
    expect(isAllowedApiRequest('/api/v1/market/candles?instrument=BTC-USDT', 'GET')).toBe(true);
    expect(isAllowedApiRequest('/api/v1/forecasts/v2/latest?instrument=BTC-USDT&scope=future_close', 'GET')).toBe(true);
    expect(isAllowedApiRequest('/api/v1/forecasts/f-1/replay', 'POST')).toBe(true);
    expect(isAllowedApiRequest('/api/v1/settings/public', 'PATCH')).toBe(true);
    expect(isAllowedApiRequest('/api/v1/settings/public', 'POST')).toBe(false);
    expect(isAllowedApiRequest('/api/v1/settings/secret', 'GET')).toBe(false);
    expect(isAllowedApiRequest('/api/v1/admin', 'GET')).toBe(false);
  });

  it.each([
    '/api/v1/orders',
    '/api/v1/trade/place',
    '/api/v1/accounts/private',
    '/api/v1/withdrawals',
    '/api/v1/reports/../accounts',
    '/health',
  ])('rejects prohibited or out-of-contract route %s', (path) => {
    expect(() => normalizeApiPath(path)).toThrow();
  });
});

describe('safe report filename', () => {
  it('removes Windows path metacharacters', () => {
    expect(safeExportName('周报:BTC/ETH?')).toBe('周报_BTC_ETH_');
  });
});

