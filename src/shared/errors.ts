/**
 * 结构化错误：所有跨进程调用与适配器实现都必须返回此类错误，
 * 不得把异常堆栈或第三方原始文字直接作为 UI 状态。
 */
export type StructuredErrorCode =
  | "not_installed"
  | "not_authenticated"
  | "permission_denied"
  | "unsupported_version"
  | "session_unavailable"
  | "process_failed"
  | "invalid_data"
  | "conflict"
  | "incomplete_source"
  | "unknown";

export class WorkbenchError extends Error {
  readonly code: StructuredErrorCode;
  readonly agentId?: string;
  readonly details?: unknown;

  constructor(code: StructuredErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkbenchError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details ?? null };
  }
}

export function isWorkbenchError(e: unknown): e is WorkbenchError {
  return e instanceof WorkbenchError || (typeof e === "object" && e !== null && "code" in e);
}

/** 将任意未知异常收敛为结构化错误，绝不泄露内部细节给 UI。 */
export function toWorkbenchError(e: unknown): WorkbenchError {
  if (e instanceof WorkbenchError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new WorkbenchError("unknown", msg);
}
