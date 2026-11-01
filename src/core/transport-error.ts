/** Exact transport diagnostics, not arbitrary mentions of networking in normal answers. */
export function isTransportErrorText(text: string): boolean {
  return /^(?:Warning: Model metadata[^\n]*\n\s*)?(?:stream disconnected before completion:\s*(?:error sending request for url|stream idle timeout|connection)|error sending request for url\s*\(|(?:Error:\s*)?(?:connect ETIMEDOUT|connect ECONNREFUSED|read ECONNRESET|fetch failed)\b)/iu.test(text.trim());
}
