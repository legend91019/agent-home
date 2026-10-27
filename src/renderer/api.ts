/** 渲染层统一调用入口：封装 window.api 的类型化调用与错误归一化。 */
import type { IpcApi } from "../shared/ipc-api";
import type { IpcChannel } from "../shared/contracts";
import { WorkbenchError } from "../shared/errors";

const api = window.api as IpcApi;

export async function call<K extends IpcChannel>(
  channel: K,
  input: Parameters<IpcApi[K]>[0],
): Promise<Awaited<ReturnType<IpcApi[K]>>> {
  try {
    return (await api[channel](input)) as Awaited<ReturnType<IpcApi[K]>>;
  } catch (err) {
    if (err instanceof WorkbenchError) throw err;
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      throw new WorkbenchError(
        (err as { code: WorkbenchError["code"] }).code,
        String((err as { message: unknown }).message),
      );
    }
    throw new WorkbenchError("unknown", err instanceof Error ? err.message : String(err));
  }
}

export type { IpcApi };
