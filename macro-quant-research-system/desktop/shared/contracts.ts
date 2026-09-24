export type ApiMethod = 'GET' | 'POST' | 'PATCH';

export interface ApiRequest {
  path: string;
  method?: ApiMethod;
  body?: unknown;
  timeoutMs?: number;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  receivedAt: string;
}

export interface ExportRequest {
  suggestedName: string;
  content: string;
  format: 'md' | 'json' | 'csv';
}

export interface ExportResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export interface DesktopBridge {
  api: {
    request<T = unknown>(request: ApiRequest): Promise<ApiResult<T>>;
    getBaseUrl(): Promise<string>;
    setBaseUrl(value: string): Promise<string>;
  };
  report: {
    export(request: ExportRequest): Promise<ExportResult>;
  };
  app: {
    version(): Promise<string>;
    platform: string;
  };
}

