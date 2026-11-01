import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

type SessionState = {
  abortController?: AbortController;
};

class MockAgent {
  private readonly sessions = new Map<string, SessionState>();

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          close: {},
        },
        promptCapabilities: {
          image: true,
        },
      },
      agentInfo: {
        name: 'mock-qq-agent',
        version: '0.1.3',
      },
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {});
    return { sessionId };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    if (!this.sessions.has(params.sessionId)) {
      this.sessions.set(params.sessionId, {});
    }
    return {};
  }

  async listSessions(): Promise<acp.ListSessionsResponse> {
    return {
      sessions: [...this.sessions.keys()].map((sessionId) => ({
        sessionId,
        cwd: process.cwd(),
      })),
    };
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    this.sessions.delete(params.sessionId);
    return {};
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`session ${params.sessionId} not found`);
    }

    session.abortController?.abort();
    session.abortController = new AbortController();
    const signal = session.abortController.signal;

    const textPrompt = params.prompt
      .filter((block): block is Extract<acp.ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const imageCount = params.prompt.filter((block) => block.type === 'image').length;

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: '理解用户问题', priority: 'high', status: 'completed' },
          { content: '检索上下文并生成答案', priority: 'high', status: 'in_progress' },
          { content: '返回结果', priority: 'medium', status: 'pending' },
        ],
      },
    });
    await this.sleep(signal, 120);

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'mock-search',
        title: 'Mock Search',
        kind: 'read',
        status: 'in_progress',
      },
    });
    await this.sleep(signal, 120);

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mock-search',
        status: 'completed',
        result: {
          summary: 'Fetched mock context successfully',
        },
      },
    });
    await this.sleep(signal, 120);

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `【Mock Agent】收到：${textPrompt || '（空文本）'}${imageCount ? `；并检测到 ${imageCount} 张图片` : ''}。`,
        },
      },
    });

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: ' 这是一个用于联调 QQ ↔ ACP 链路的模拟答复。',
        },
      },
    });

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          mimeType: 'image/png',
          data: 'ZmFrZS1vdXRwdXQtaW1hZ2U=',
          uri: 'https://example.com/mock-output.png',
        },
      },
    });

    return {
      stopReason: 'end_turn',
      usage: {
        totalTokens: 42,
        inputTokens: 20,
        outputTokens: 22,
      },
    };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.abortController?.abort();
  }

  private async sleep(signal: AbortSignal, ms: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream;
const output = Readable.toWeb(process.stdin) as ReadableStream;
const stream = acp.ndJsonStream(input, output);
const agent = new MockAgent();

acp
  .agent({ name: 'mock-qq-agent' })
  .onRequest(acp.methods.agent.initialize, () => agent.initialize())
  .onRequest(acp.methods.agent.session.new, () => agent.newSession())
  .onRequest(acp.methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
  .onRequest(acp.methods.agent.session.list, () => agent.listSessions())
  .onRequest(acp.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
  .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
  .connect(stream);
