/**
 * Preload：通过 contextBridge 只暴露受白名单约束的 API 到渲染进程的
 * window.api。渲染层永远无法直接读写任意路径或执行任意命令。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/contracts";
import type { IpcApi } from "../shared/ipc-api";

const api = {} as Record<string, (input: unknown) => Promise<unknown>>;
for (const channel of IPC_CHANNELS) {
  api[channel] = (input: unknown) => ipcRenderer.invoke(channel, input);
}

// 仅暴露白名单方法，类型由 IpcApi 保证。
contextBridge.exposeInMainWorld("api", api as unknown as IpcApi);
