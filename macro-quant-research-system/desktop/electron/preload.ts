import { contextBridge, ipcRenderer } from 'electron';
import { ApiRequest, DesktopBridge, ExportRequest } from '../shared/contracts';

const bridge: DesktopBridge = Object.freeze({
  api: Object.freeze({
    request: <T = unknown>(request: ApiRequest) => ipcRenderer.invoke('api:request', request) as Promise<import('../shared/contracts').ApiResult<T>>,
    getBaseUrl: () => ipcRenderer.invoke('api:get-base') as Promise<string>,
    setBaseUrl: (value: string) => ipcRenderer.invoke('api:set-base', value) as Promise<string>,
  }),
  report: Object.freeze({
    export: (request: ExportRequest) => ipcRenderer.invoke('report:export', request),
  }),
  app: Object.freeze({
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    platform: process.platform,
  }),
});

contextBridge.exposeInMainWorld('macroDesktop', bridge);

