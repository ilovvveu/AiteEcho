import { describe, expect, it } from 'vitest';
import { sanitizeAcpAgentText } from './text.js';

describe('sanitizeAcpAgentText', () => {
  it('removes the Codex custom-model metadata warning from the start of a reply', () => {
    expect(
      sanitizeAcpAgentText(
        'Warning: Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n正常回答',
      ),
    ).toBe('正常回答');
  });

  it('does not alter ordinary warning text or later quoted text', () => {
    expect(sanitizeAcpAgentText('Warning: 请检查输入。')).toBe('Warning: 请检查输入。');
    expect(
      sanitizeAcpAgentText(
        '前言\nWarning: Model metadata for `x` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      ),
    ).toContain('Model metadata');
  });
});
