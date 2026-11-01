export const EMPTY_AGENT_REPLY_FALLBACK = '⚠️ 模型返回了空内容，请重新发送一次。';

export function ensureVisibleAgentReply(text: string, outputImageCount: number): string {
  if (text.trim() || outputImageCount > 0) {
    return text;
  }
  return EMPTY_AGENT_REPLY_FALLBACK;
}
