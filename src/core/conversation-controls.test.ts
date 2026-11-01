import { describe, expect, it } from 'vitest';
import {
  handleConversationControlCommand,
  resolveConversationModes,
} from './conversation-controls.js';

describe('resolveConversationModes', () => {
  it('falls back to global defaults when no override exists', () => {
    const resolved = resolveConversationModes({
      defaultProgressMode: 'message',
      defaultVerboseMode: 'verbose',
    });

    expect(resolved).toEqual({
      progressMode: 'message',
      progressSource: 'default',
      verboseMode: 'verbose',
      verboseSource: 'default',
    });
  });

  it('prefers conversation overrides when present', () => {
    const resolved = resolveConversationModes(
      {
        defaultProgressMode: 'message',
        defaultVerboseMode: 'verbose',
      },
      {
        progressModeOverride: 'off',
        verboseModeOverride: 'normal',
      },
    );

    expect(resolved).toEqual({
      progressMode: 'off',
      progressSource: 'conversation',
      verboseMode: 'normal',
      verboseSource: 'conversation',
    });
  });
});

describe('handleConversationControlCommand', () => {
  const defaults = {
    prefix: '/',
    defaultProgressMode: 'message' as const,
    defaultVerboseMode: 'verbose' as const,
  };

  it('shows current verbose mode when no args are provided', () => {
    const result = handleConversationControlCommand({
      ...defaults,
      commandName: 'verbose',
      args: [],
    });

    expect(result).not.toBeNull();
    expect(result?.patch).toBeUndefined();
    expect(result?.message).toContain('当前会话详细模式');
    expect(result?.message).toContain('/verbose normal');
  });

  it('supports switching verbose mode with off alias', () => {
    const result = handleConversationControlCommand({
      ...defaults,
      commandName: 'verbose',
      args: ['off'],
    });

    expect(result).not.toBeNull();
    expect(result?.patch).toEqual({
      verboseModeOverride: 'normal',
    });
    expect(result?.message).toContain('normal');
  });

  it('supports clearing verbose override back to default', () => {
    const result = handleConversationControlCommand({
      ...defaults,
      commandName: 'verbose',
      args: ['default'],
      persisted: {
        verboseModeOverride: 'debug',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.patch).toEqual({
      verboseModeOverride: undefined,
    });
    expect(result?.message).toContain('全局默认');
    expect(result?.message).toContain('verbose');
  });

  it('supports turning progress reporting off', () => {
    const result = handleConversationControlCommand({
      ...defaults,
      commandName: 'progress',
      args: ['off'],
    });

    expect(result).not.toBeNull();
    expect(result?.patch).toEqual({
      progressModeOverride: 'off',
    });
    expect(result?.message).toContain('处理中汇报');
    expect(result?.message).toContain('关闭');
  });

  it('supports quiet shortcut', () => {
    const result = handleConversationControlCommand({
      ...defaults,
      commandName: 'quiet',
      args: [],
      persisted: {
        progressModeOverride: 'message',
        verboseModeOverride: 'debug',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.patch).toEqual({
      progressModeOverride: 'off',
      verboseModeOverride: 'normal',
    });
    expect(result?.message).toContain('安静模式');
    expect(result?.message).toContain('progress=off');
    expect(result?.message).toContain('verbose=normal');
  });
});
