import { describe, expect, it } from 'vitest';
import { EMPTY_AGENT_REPLY_FALLBACK, ensureVisibleAgentReply } from './agent-reply.js';

describe('ensureVisibleAgentReply', () => {
  it('keeps a normal text reply', () => {
    expect(ensureVisibleAgentReply('一加一等于二。', 0)).toBe('一加一等于二。');
  });

  it('adds a visible fallback for an empty text-only reply', () => {
    expect(ensureVisibleAgentReply('   ', 0)).toBe(EMPTY_AGENT_REPLY_FALLBACK);
  });

  it('keeps image-only replies free of fallback text', () => {
    expect(ensureVisibleAgentReply('', 1)).toBe('');
  });
});
