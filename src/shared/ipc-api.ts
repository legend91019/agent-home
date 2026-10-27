/**
 * 渲染进程使用的 IPC 客户端类型。preload 实现此接口并暴露到 window.api；
 * 渲染进程按此契约调用，绝不直接读写任意路径或执行任意命令。
 */
import { IpcChannel, IpcContract } from "./contracts";

export type IpcApi = {
  [K in IpcChannel]: (input: IpcContract[K]["input"]) => Promise<IpcContract[K]["output"]>;
};
