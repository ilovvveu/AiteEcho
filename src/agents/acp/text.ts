const MODEL_METADATA_WARNING =
  /^Warning: Model metadata for `[^`\r\n]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/u;

export function sanitizeAcpAgentText(text: string): string {
  return text.replace(MODEL_METADATA_WARNING, '');
}
