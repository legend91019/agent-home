import type { IpcApi } from "../shared/ipc-api";

declare global {
  interface Window {
    /** 由 preload 暴露的受白名单约束的 IPC 客户端 */
    api: IpcApi;
  }
}

export {};
