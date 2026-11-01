import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { logger } from '../../infra/logger.js';
import { ACPAgentBridge } from './bridge.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function createBridge(): ACPAgentBridge {
  process.env.ACP_AGENT_COMMAND = process.execPath;
  process.env.ACP_AGENT_ARGS_JSON = JSON.stringify(['--import', 'tsx', 'src/examples/mock-acp-agent.ts']);
  process.env.ACP_AGENT_WORKDIR = repoRoot;
  process.env.ACP_VERBOSE_MODE = 'verbose';

  const config = loadConfig(process.env);
  return new ACPAgentBridge(config, logger.child({ test: 'acp-bridge-image' }));
}

describe('ACPAgentBridge image outputs', () => {
  it('starts a fresh bounded session instead of loading the old ID and registers before the model call', async () => {
    const bridge = new ACPAgentBridge(loadConfig({}), logger); const internal = bridge as any;
    const ready = vi.fn(async () => undefined);
    const stop = vi.spyOn(bridge, 'stop').mockResolvedValue();
    const started = vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => {
      internal.remoteSessionId = 'new-session';
      internal.connection = { prompt: async () => {
        expect(ready).toHaveBeenCalledWith('new-session');
        internal.handleSessionUpdate({ sessionId: 'new-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } });
        return { stopReason: 'end_turn' };
      } };
    });
    expect((await bridge.sendPrompt({ text: 'new', freshSession: true, sessionIdHint: 'old-session', onSessionReady: ready })).text).toBe('OK');
    expect(stop).toHaveBeenCalledOnce(); expect(started).toHaveBeenCalledWith(undefined);
  });
  it('does not spend a continuation request when Grok already produced a final answer after the tool', async () => {
    const bridge = new ACPAgentBridge(loadConfig({ ACP_GROK_COMPAT: 'true' }), logger.child({ test: 'grok-final' }));
    const internal = bridge as any;
    const prompt = vi.fn(async () => {
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'tool_call_update', toolCallId: 'search', status: 'completed' } });
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final result' } } });
      return { stopReason: 'end_turn' };
    });
    vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => { internal.remoteSessionId = 'current'; internal.connection = { prompt }; });
    expect((await bridge.sendPrompt({ text: 'search' })).text).toBe('Final result');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('continues a Grok tool-only ending once, replacing commentary with the final answer', async () => {
    const bridge = new ACPAgentBridge(loadConfig({ ACP_GROK_COMPAT: 'true' }), logger.child({ test: 'grok-continuation' }));
    const internal = bridge as any;
    const prompt = vi.fn().mockImplementationOnce(async () => {
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will search.' } } });
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'tool_call_update', toolCallId: 'search', status: 'completed' } });
      return { stopReason: 'end_turn' };
    }).mockImplementationOnce(async () => {
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Result: https://docs.python.org/3/' } } });
      return { stopReason: 'end_turn' };
    });
    vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => { internal.remoteSessionId = 'current'; internal.connection = { prompt }; });
    expect((await bridge.sendPrompt({ text: 'search' })).text).toBe('Result: https://docs.python.org/3/');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]![0].sessionId).toBe('current');
  });

  it('never loops when Grok fails to provide an answer after the bounded continuation', async () => {
    const bridge = new ACPAgentBridge(loadConfig({ ACP_GROK_COMPAT: 'true' }), logger.child({ test: 'grok-continuation-cap' }));
    const internal = bridge as any;
    const prompt = vi.fn(async () => {
      internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'tool_call_update', toolCallId: 'search', status: 'completed' } });
      return { stopReason: 'end_turn' };
    });
    vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => { internal.remoteSessionId = 'current'; internal.connection = { prompt }; });
    await expect(bridge.sendPrompt({ text: 'search' })).rejects.toThrow('仍未生成最终答复');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('excludes load-session replay and other-session updates from the current answer', async () => {
    const bridge = new ACPAgentBridge(loadConfig({}), logger.child({ test: 'replay-gate' }));
    const internal = bridge as any;
    const notify = (sessionId: string, text: string) => internal.handleSessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => {
      internal.remoteSessionId = 'current';
      notify('current', 'OLD_REPLY');
      internal.connection = { prompt: async () => {
        notify('other', 'OTHER_SESSION');
        notify('current', 'NEW_REPLY');
        return { stopReason: 'end_turn' };
      } };
    });
    const response = await bridge.sendPrompt({ text: 'continue', sessionIdHint: 'current' });
    expect(response.text).toBe('NEW_REPLY');
    notify('current', 'LATE_REPLAY');
    expect(bridge.getState().accumulatedText).toBe('NEW_REPLY');
  });

  it('treats a Grok error envelope as prompt failure, even with end_turn', async () => {
    const config = loadConfig({ ACP_GROK_COMPAT: 'true' });
    const failed = vi.fn();
    const bridge = new ACPAgentBridge(config, logger.child({ test: 'grok-error' }), { onPromptFailed: failed });
    const internal = bridge as any;
    vi.spyOn(bridge, 'ensureStarted').mockImplementation(async () => {
      internal.remoteSessionId = 'current';
      internal.connection = { prompt: async () => {
        internal.handleSessionUpdate({ sessionId: 'current', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"error":{"code":"upstream_error","message":"private details"}}' } } });
        return { stopReason: 'end_turn' };
      } };
    });
    await expect(bridge.sendPrompt({ text: 'hello' })).rejects.toThrow('Grok 接口返回错误');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(internal.acceptingPromptUpdates).toBe(false);
  });

  it('returns ACP image chunks together with text', async () => {
    const bridge = createBridge();

    try {
      const response = await bridge.sendPrompt({
        text: '请给我一张图',
      });

      expect(response.text).toContain('【Mock Agent】收到');
      expect(response.images).toEqual([
        {
          mimeType: 'image/png',
          base64Data: 'ZmFrZS1vdXRwdXQtaW1hZ2U=',
          uri: 'https://example.com/mock-output.png',
        },
      ]);
    } finally {
      await bridge.stop();
    }
  });
});
