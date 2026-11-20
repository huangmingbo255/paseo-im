/** Errors whose message may be shown verbatim to users in UI and on IM. */
export class UserFacingError extends Error {}

export function userMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/agent_request_key_conflict/i.test(message)) {
    return "Paseo 创建项目会话时发生幂等键冲突，请重试；如果持续失败，请在 IM 设置中重新选择工作区。";
  }
  if (/workspace is archived|workspace.*archiv/i.test(message)) {
    return "所选工作区已归档，请在 Paseo → IM 中重新选择一个活动工作区。";
  }
  return "任务需要在 Paseo 中处理，请打开 Paseo 查看详情。";
}
