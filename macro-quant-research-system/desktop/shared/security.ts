export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8766';

const BLOCKED_ROUTE_PATTERN = /(?:^|\/)(?:orders?|trades?|withdrawals?|transfers?|accounts?)(?:\/|$)/i;

const READ_ROUTE_PATTERNS = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/market\/(?:status|candles)(?:\?|$)/,
  /^\/api\/v1\/forecasts\/(?:latest|history)(?:\?|$)/,
  /^\/api\/v1\/forecasts\/v2\/(?:latest|history)(?:\?|$)/,
  /^\/api\/v1\/forecasts\/[^/?#]+$/,
  /^\/api\/v1\/(?:scenarios|events|revisions)(?:\?|$)/,
  /^\/api\/v1\/audit\/status$/,
  /^\/api\/v1\/reports$/,
  /^\/api\/v1\/reports\/[^/?#]+\/export$/,
  /^\/api\/v1\/settings\/(?:public|credential-status)$/,
];

export function normalizeLoopbackBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) {
    throw new Error('接口地址不能为空');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('接口地址格式无效');
  }

  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('桌面端仅允许连接 http://127.0.0.1 上的本地 FastAPI 服务');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('接口地址不能包含凭据、查询参数或片段');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('接口地址只填写服务根地址，不包含 API 路径');
  }

  parsed.pathname = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeApiPath(value: string): string {
  if (!value.startsWith('/api/v1/') && value !== '/api/v1') {
    throw new Error('仅允许访问 /api/v1 下的只读审计接口');
  }
  if (value.includes('\\') || value.includes('..') || /^\/\//.test(value)) {
    throw new Error('API 路径无效');
  }

  const pathname = value.split(/[?#]/, 1)[0];
  if (BLOCKED_ROUTE_PATTERN.test(pathname)) {
    throw new Error('客户端禁止访问交易、账户、转账或提现接口');
  }
  return value;
}

export function isAllowedApiRequest(path: string, method: string): boolean {
  const safePath = normalizeApiPath(path);
  if (method === 'GET') return READ_ROUTE_PATTERNS.some((pattern) => pattern.test(safePath));
  if (method === 'POST') {
    return /^\/api\/v1\/forecasts\/[^/?#]+\/replay$/.test(safePath) || safePath === '/api/v1/settings/probe';
  }
  return method === 'PATCH' && safePath === '/api/v1/settings/public';
}

export function safeExportName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (cleaned || '审计报告').slice(0, 96);
}

