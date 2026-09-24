import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  Tray,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ApiRequest, ApiResult, ExportRequest, ExportResult } from '../shared/contracts';
import {
  DEFAULT_API_BASE_URL,
  isAllowedApiRequest,
  normalizeApiPath,
  normalizeLoopbackBaseUrl,
  safeExportName,
} from '../shared/security';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let apiBaseUrl = normalizeConfiguredBase(process.env.MACRO_API_BASE_URL);
let managedBackend: ChildProcess | null = null;

function findWorkspaceRoot(): string | undefined {
  const seeds = [process.env.MACRO_WORKSPACE, process.cwd(), path.dirname(process.execPath), __dirname].filter(
    (value): value is string => Boolean(value),
  );
  for (const seed of seeds) {
    let current = path.resolve(seed);
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(path.join(current, 'backend', 'app.py')) && existsSync(path.join(current, 'config', 'app.json'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

function findWorkspacePython(workspace: string): string | undefined {
  const candidates = process.env.MACRO_PYTHON
    ? [process.env.MACRO_PYTHON]
    : [path.join(workspace, '.venv', 'Scripts', 'python.exe'), path.join(workspace, '.venv', 'bin', 'python')];
  return candidates.find((candidate) => existsSync(candidate));
}

async function backendHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLocalBackend(): Promise<void> {
  if (await backendHealthy()) return;
  if (process.env.MACRO_DISABLE_BACKEND_AUTOSTART === '1') return;
  const workspace = findWorkspaceRoot();
  const python = workspace ? findWorkspacePython(workspace) : undefined;
  if (!workspace || !python) return;

  let port = '8766';
  try {
    port = new URL(apiBaseUrl).port || port;
  } catch {
    return;
  }
  try {
    managedBackend = spawn(
      python,
      ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', port],
      { cwd: workspace, windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    return;
  }
  const child = managedBackend;
  child.once('error', () => {
    if (managedBackend === child) managedBackend = null;
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await backendHealthy()) return;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function stopManagedBackend(): void {
  if (managedBackend && managedBackend.exitCode === null) managedBackend.kill();
  managedBackend = null;
}

function normalizeConfiguredBase(value: string | undefined): string {
  if (!value) return DEFAULT_API_BASE_URL;
  try {
    return normalizeLoopbackBaseUrl(value);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function trayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="8" fill="#0d1726"/>',
    '<path d="M6 22L12 15L17 19L25 9" fill="none" stroke="#4ce0b3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    '<circle cx="25" cy="9" r="2.5" fill="#f5b85c"/>',
    '</svg>',
  ].join('');
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 16, height: 16 });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#08101c',
    title: '日线宏观量化审计台',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (targetUrl !== currentUrl) event.preventDefault();
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once('ready-to-show', () => window.show());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const parsed = new URL(devUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      throw new Error('开发服务器必须绑定 127.0.0.1');
    }
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  return window;
}

function createTray(): Tray {
  const nextTray = new Tray(trayIcon());
  nextTray.setToolTip('日线宏观量化审计台（只读）');
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开审计台',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  nextTray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  return nextTray;
}

function toApiResult<T>(partial: Omit<ApiResult<T>, 'receivedAt'>): ApiResult<T> {
  return { ...partial, receivedAt: new Date().toISOString() };
}

async function callApi(request: ApiRequest): Promise<ApiResult> {
  let safePath: string;
  try {
    safePath = normalizeApiPath(request.path);
  } catch (error) {
    return toApiResult({ ok: false, status: 0, error: error instanceof Error ? error.message : 'API 路径无效' });
  }

  const method = request.method ?? 'GET';
  if (!['GET', 'POST', 'PATCH'].includes(method)) {
    return toApiResult({ ok: false, status: 0, error: '不允许的请求方法' });
  }
  if (!isAllowedApiRequest(safePath, method)) {
    return toApiResult({ ok: false, status: 0, error: '请求不在桌面端只读审计接口白名单中' });
  }

  const controller = new AbortController();
  const timeout = Math.min(Math.max(request.timeoutMs ?? 10_000, 1_000), 30_000);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${apiBaseUrl}${safePath}`, {
      method,
      headers: {
        Accept: 'application/json, text/plain;q=0.9',
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    let data: unknown = raw;
    if (contentType.includes('application/json') && raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        return toApiResult({ ok: false, status: response.status, error: '后端返回了无法解析的 JSON' });
      }
    }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data ? String((data as { detail: unknown }).detail) : raw;
      return toApiResult({ ok: false, status: response.status, error: detail || `HTTP ${response.status}` });
    }
    return toApiResult({ ok: true, status: response.status, data });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `本地后端 ${timeout / 1000} 秒内未响应`
      : `无法连接本地 FastAPI（${apiBaseUrl}）；界面已进入降级只读状态`;
    return toApiResult({ ok: false, status: 0, error: message });
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc(): void {
  ipcMain.handle('api:request', (_event, request: ApiRequest) => callApi(request));
  ipcMain.handle('api:get-base', () => apiBaseUrl);
  ipcMain.handle('api:set-base', (_event, value: string) => {
    apiBaseUrl = normalizeLoopbackBaseUrl(value);
    return apiBaseUrl;
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('report:export', async (_event, request: ExportRequest): Promise<ExportResult> => {
    if (!request || typeof request.content !== 'string' || request.content.length > 20_000_000) {
      return { ok: false, error: '导出内容为空或超过 20 MB 限制' };
    }
    const extensions = { md: 'md', json: 'json', csv: 'csv' } as const;
    const format = extensions[request.format];
    if (!format) return { ok: false, error: '不支持的导出格式' };
    const options = {
      title: '导出审计报告',
      defaultPath: `${safeExportName(request.suggestedName)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      await writeFile(result.filePath, request.content, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '导出失败' };
    }
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file:') || details.url.startsWith('devtools:') || details.url.startsWith('http://127.0.0.1:5173') || details.url.startsWith('ws://127.0.0.1:5173');
    callback({ cancel: !allowed });
  });
  registerIpc();
  await ensureLocalBackend();
  mainWindow = createWindow();
  tray = createTray();
});

app.on('activate', () => {
  if (!mainWindow) mainWindow = createWindow();
  mainWindow.show();
});

app.on('window-all-closed', () => {
  // Keep the process alive in the tray until the explicit “退出” action.
});

app.on('before-quit', () => {
  quitting = true;
  stopManagedBackend();
});

