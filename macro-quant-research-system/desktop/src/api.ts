import type { ApiRequest, ApiResult, ExportRequest, ExportResult } from '../shared/contracts';
import { DEFAULT_API_BASE_URL } from '../shared/security';

export async function requestApi<T = unknown>(request: ApiRequest): Promise<ApiResult<T>> {
  if (!window.macroDesktop) {
    return {
      ok: false,
      status: 0,
      error: 'Electron 安全桥未加载；请从桌面客户端启动',
      receivedAt: new Date().toISOString(),
    };
  }
  return window.macroDesktop.api.request<T>(request);
}

export async function getApiBaseUrl(): Promise<string> {
  return window.macroDesktop?.api.getBaseUrl() ?? DEFAULT_API_BASE_URL;
}

export async function setApiBaseUrl(value: string): Promise<string> {
  if (!window.macroDesktop) throw new Error('Electron 安全桥未加载');
  return window.macroDesktop.api.setBaseUrl(value);
}

export async function exportReport(request: ExportRequest): Promise<ExportResult> {
  if (!window.macroDesktop) return { ok: false, error: 'Electron 安全桥未加载' };
  return window.macroDesktop.report.export(request);
}

export function unwrapData<T>(value: unknown): T | undefined {
  if (value && typeof value === 'object' && 'data' in value) {
    return (value as { data?: T }).data;
  }
  return value as T | undefined;
}

export function unwrapItems<T>(value: unknown): T[] {
  const unwrapped = unwrapData<unknown>(value);
  if (Array.isArray(unwrapped)) return unwrapped as T[];
  if (unwrapped && typeof unwrapped === 'object') {
    for (const key of ['items', 'forecasts', 'events', 'revisions', 'scenarios', 'reports', 'results']) {
      const candidate = (unwrapped as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

export function unwrapObject<T extends object>(value: unknown): T | undefined {
  const unwrapped = unwrapData<unknown>(value);
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) return unwrapped as T;
  return undefined;
}

