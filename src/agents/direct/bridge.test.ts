import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { Diagnostics } from '../../infra/diagnostics.js';
import { DirectApiBridge, buildDirectRequest } from './bridge.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function fixture(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const config = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`, QQ_CODEX_API_KEY: 'test-only-key', CONTEXT_BOUNDED: 'true' });
  const diagnostics = new Diagnostics();
  return { config, diagnostics, bridge: new DirectApiBridge(config, diagnostics) };
}
const completed = (text = 'OK') => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 50, output_tokens: 3 } });
describe('direct stateless API backend', () => {
  it('omits history by default even if a caller accidentally supplies it, while retaining current quote/document/style', () => {
    const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only', CONTEXT_BOUNDED: 'true' });
    const p = { text: 'CURRENT_QUESTION', systemPrompt: 'CURRENT_STYLE', contextLines: ['EXPLICIT_QUOTE', 'CURRENT_DOCUMENT'],
      historyContextLines: [JSON.stringify([{ at: Date.now(), user: 'OLD_PRIVATE_QUESTION', assistant: 'OLD_PRIVATE_ANSWER' }])] };
    const defaultRequest = buildDirectRequest(c, p);
    expect(defaultRequest.stats.historyChars).toBe(0);
    const raw = JSON.stringify(defaultRequest.body); expect(raw).not.toContain('OLD_PRIVATE');
    expect(raw).toContain('EXPLICIT_QUOTE'); expect(raw).toContain('CURRENT_DOCUMENT'); expect(raw).toContain('CURRENT_STYLE');
    expect(JSON.stringify(buildDirectRequest(c, { ...p, includeHistory: true }).body)).toContain('OLD_PRIVATE_ANSWER');
  });
  it('does not depend on invalid environment proxies or a missing Codex executable', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1'); vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1'); vi.stubEnv('CODEX_PATH', '/missing/codex');
    const { bridge } = await fixture((_, res) => res.end(JSON.stringify(completed())));
    expect((await bridge.sendPrompt({ text: 'Q' })).text).toBe('OK');
  });
  it('uses one non-stream request, keeps high, sends images, and never needs Codex/session IDs', async () => {
    let payload: any, headers: any, calls = 0;
    const { bridge, diagnostics } = await fixture(async (req, res) => {
      calls++; let body = ''; for await (const chunk of req) body += chunk;
      payload = JSON.parse(body); headers = req.headers;
      res.setHeader('x-request-id', 'test-request-1'); res.end(JSON.stringify(completed()));
    });
    let registered = false;
    const r = await bridge.sendPrompt({ text: 'QUESTION', images: [{ mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
      sessionIdHint: 'never-reuse', onSessionReady: async () => { registered = true; }, correlationId: 'trace-test' });
    expect(r.text).toBe('OK'); expect(calls).toBe(1); expect(registered).toBe(false); expect(bridge.getSessionId()).toBeUndefined();
    expect(payload).toMatchObject({ model: 'synthetic-test-model', reasoning: { effort: 'high' }, store: false, stream: false });
    expect(payload).not.toHaveProperty('include'); expect(payload).not.toHaveProperty('previous_response_id');
    expect(payload.input[1].content[1].image_url).toBe('data:image/png;base64,aGVsbG8=');
    expect(headers.authorization).toBe('Bearer test-only-key');
    expect(headers.connection).toBe('keep-alive');
    expect(diagnostics.status().state).toBe('ok');
    expect(JSON.stringify(diagnostics.status())).not.toContain('QUESTION');
    expect(JSON.stringify(diagnostics.status())).not.toContain('test-only-key');
  });
  it('fully receives delayed response chunks, then closes its own socket without cross-request reuse', async () => {
    const sockets: unknown[] = [], closed: Promise<void>[] = [];
    const body = JSON.stringify(completed('SYNTHETIC_'.repeat(4000) + 'FINAL_TAIL'));
    const {bridge,diagnostics} = await fixture((req,res) => {
      expect(req.headers.connection).toBe('keep-alive');sockets.push(req.socket);
      closed.push(once(req.socket,'close').then(()=>{}));
      res.writeHead(200,{'content-length':Buffer.byteLength(body),'x-request-id':'complete-731'});
      res.write(body.slice(0,100));setTimeout(()=>res.end(body.slice(100)),10);
    });
    expect((await bridge.sendPrompt({text:'Q'})).text).toContain('FINAL_TAIL');
    expect((await bridge.sendPrompt({text:'Q2'})).text).toContain('FINAL_TAIL');
    expect(sockets[0]).not.toBe(sockets[1]);await Promise.all(closed);
    expect((diagnostics.status().recent as any[]).filter(e=>e.stage==='response_integrity').at(-1)).toMatchObject({
      outcome:'ok',bytes:Buffer.byteLength(body),expectedBytes:Buffer.byteLength(body),responseComplete:true,
      responseBodyStarted:true,requestConnection:'keep-alive',responseFraming:'content-length',
    });
  });
  it('rejects a truncated HTTP 200 even if all received bytes form valid JSON; no paid retry or raw log leakage', async () => {
    let calls=0;const body=JSON.stringify(completed('PRIVATE_TRUNCATED_ANSWER'));
    const {bridge,diagnostics}=await fixture((_,res)=>{
      calls++;const socket=res.socket!;
      res.writeHead(200,{'content-length':Buffer.byteLength(body)+64,'x-request-id':'cut-731','x-private-header':'DO_NOT_LOG_HEADER'});
      res.end(body);setTimeout(()=>socket.end(),5);
    });
    await expect(bridge.sendPrompt({text:'PRIVATE_QUESTION',correlationId:'cut-trace'})).rejects.toMatchObject({code:'RESPONSE_ABORTED',retryable:false});
    expect(calls).toBe(1);
    expect((diagnostics.status().recent as any[]).find(e=>e.stage==='response_integrity')).toMatchObject({
      outcome:'error',code:'RESPONSE_ABORTED',bytes:Buffer.byteLength(body),expectedBytes:Buffer.byteLength(body)+64,
      responseComplete:false,responseBodyStarted:true,httpStatus:200,
    });
    expect(JSON.stringify(diagnostics.status())).not.toMatch(/PRIVATE_TRUNCATED_ANSWER|PRIVATE_QUESTION|DO_NOT_LOG_HEADER|test-only-key/);
  });
  it('records zero received bytes for a connection lost immediately after headers and does not retry', async () => {
    let calls=0;const {bridge,diagnostics}=await fixture((_,res)=>{
      calls++;res.writeHead(200,{'content-length':256});res.flushHeaders();setTimeout(()=>res.socket?.end(),5);
    });
    await expect(bridge.sendPrompt({text:'Q'})).rejects.toMatchObject({code:'RESPONSE_ABORTED'});expect(calls).toBe(1);
    expect((diagnostics.status().recent as any[]).find(e=>e.stage==='response_integrity')).toMatchObject({
      outcome:'error',bytes:0,expectedBytes:256,responseComplete:false,responseBodyStarted:false,
    });
  });
  it('accepts complete chunked responses without inventing a Content-Length or exposing unknown connection headers', async () => {
    const body=JSON.stringify(completed());
    const {bridge,diagnostics}=await fixture((_,res)=>{
      res.setHeader('connection','keep-alive, PRIVATE_VALUE');res.flushHeaders();res.write(body.slice(0,20));res.end(body.slice(20));
    });
    expect((await bridge.sendPrompt({text:'Q'})).text).toBe('OK');
    expect((diagnostics.status().recent as any[]).find(e=>e.stage==='response_integrity')).toMatchObject({
      outcome:'ok',responseComplete:true,bytes:Buffer.byteLength(body),responseFraming:'chunked',responseConnection:'other',
    });
    expect(JSON.stringify(diagnostics.status())).not.toContain('PRIVATE_VALUE');
  });
  it('caps ALL text, UTF8 bytes and complete historical turns, not just history', () => {
    const config = loadConfig({});
    const history = Array.from({ length: 100 }, (_, i) => ({ at: i, user: `OLD_${i}`.repeat(60), assistant: 'ANSWER'.repeat(60) }));
    const p = buildDirectRequest(config, { text: '问题'.repeat(10000), systemPrompt: '规则'.repeat(10000), contextLines: ['文档'.repeat(20000)], historyContextLines: ['untrusted', JSON.stringify(history)] });
    expect(p.stats.inputChars).toBeLessThanOrEqual(10000); expect(p.stats.inputBytes).toBeLessThanOrEqual(20000); expect(p.stats.truncated).toBe(true);
    const body = p.body as any;
    const text = body.input[0].content + body.input[1].content[0].text;
    expect(text.length).toBe(p.stats.inputChars); expect(Buffer.byteLength(text)).toBe(p.stats.inputBytes);
    expect(text).toContain('问题'); expect(text).toContain('截断'); expect(text).not.toContain('OLD_0');
  });
  it('retries a transient HTTP error only once, preserves correlation and exposes the failing stage', async () => {
    let calls = 0;
    const { bridge, diagnostics } = await fixture((_, res) => { calls++; res.statusCode = 503; res.end('{"error":"private server body"}'); });
    await expect(bridge.sendPrompt({ text: 'Q', correlationId: 'same-trace' })).rejects.toMatchObject({ stage: 'http_status', code: 'HTTP_503' });
    expect(calls).toBe(2);
    const status = JSON.stringify(diagnostics.status()); expect(status).toContain('same-trace'); expect(status).toContain('HTTP_503'); expect(status).not.toContain('private server body');
  });
  it.each([401, 403])('does not retry credentials or policy HTTP %s', async status => {
    let calls = 0;
    const { bridge } = await fixture((_, res) => { calls++; res.statusCode = status; res.end('{}'); });
    await expect(bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: `HTTP_${status}` }); expect(calls).toBe(1);
  });
  it('enforces first-byte timeout after flushed headers without replaying a submitted POST', async () => {
    let calls = 0;
    const { bridge, config, diagnostics } = await fixture(async (req, res) => { for await (const chunk of req) { void chunk; } calls++; res.writeHead(200); res.flushHeaders(); });
    config.ai.direct.firstByteTimeoutMs = 25;
    await expect(bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'FIRST_BYTE_TIMEOUT', retryable: false,
      transportState: { requestSubmitted: true } }); expect(calls).toBe(1);
    expect(diagnostics.status().recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'request_write', requestFlushed: true, requestSubmitted: true, outcome: 'ok' }),
      expect.objectContaining({ stage: 'request_state', requestFlushed: true, requestSubmitted: true, outcome: 'error' }),
      expect.objectContaining({ stage: 'api_complete', failureStage: 'first_byte', code: 'FIRST_BYTE_TIMEOUT', requestSubmitted: true }),
    ]));
  });
  it('accepts a delayed non-stream whole answer inside the configured first-body budget, without retrying', async () => {
    let calls = 0;
    const { bridge, config } = await fixture(async (req, res) => {
      for await (const chunk of req) { void chunk; } calls++;
      setTimeout(() => res.end(JSON.stringify(completed('DELAYED_FINAL'))), 80);
    });
    config.ai.direct.firstByteTimeoutMs = 300; config.ai.direct.totalTimeoutMs = 500;
    expect((await bridge.sendPrompt({ text: 'Q' })).text).toBe('DELAYED_FINAL');
    expect(calls).toBe(1);
  });
  it('bounds all attempts under one total deadline, including a silent server', async () => {
    const { bridge, config } = await fixture(() => {});
    config.ai.direct.totalTimeoutMs = 60; config.ai.direct.firstByteTimeoutMs = 500;
    const start = Date.now();
    await expect(bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(500);
  });
  it.each([
    '{bad json', JSON.stringify({ error: { message: 'secret server error' } }),
    JSON.stringify({ status: 'failed', output: [] }),
    JSON.stringify(completed('stream disconnected before completion: error sending request for url (https://private.invalid)')),
    JSON.stringify({ status: 'incomplete', output: [] }),
  ])('rejects malformed/error/incomplete output without retrying or leaking bodies: %s', async body => {
    let calls = 0;
    const { bridge, diagnostics } = await fixture((_, res) => { calls++; res.end(body); });
    await expect(bridge.sendPrompt({ text: 'Q' })).rejects.toThrow('AI接口暂时不可用'); expect(calls).toBe(1);
    expect(diagnostics.status().state).toBe('error'); expect(JSON.stringify(diagnostics.status())).not.toContain('private.invalid');
  });
  it('preserves hosted search capability and requested URL annotations without function execution', async () => {
    let payload: any;
    const { bridge, config, diagnostics } = await fixture(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c; payload = JSON.parse(raw);
      const value = completed('Answer'); (value.output[0]!.content[0] as any).annotations = [{ type: 'url_citation', url: 'https://example.org/source' }];
      (value.output as any[]).push({ type: 'web_search_call', status: 'completed' }, { type: 'web_search_call', status: 'completed' }); res.end(JSON.stringify(value));
    });
    config.ai.webSearch = true;
    expect((await bridge.sendPrompt({ text: 'Search并给出处' })).text).toContain('https://example.org/source');
    expect(payload.tools).toEqual([{ type: 'web_search', search_context_size: 'low' }]); expect(payload.max_tool_calls).toBe(1);
    expect(JSON.stringify(diagnostics.status())).toContain('"count":2');
    expect(JSON.stringify(diagnostics.status())).toContain('SEARCH_CALL_ITEMS_OVER_LIMIT');
  });
  it('omits only the explicitly unsupported tool limit while retaining search, high, output and history budgets', async () => {
    let payload: any, calls = 0;
    const { bridge, config } = await fixture(async (req, res) => {
      calls++; let raw = ''; for await (const chunk of req) raw += chunk;
      payload = JSON.parse(raw);
      if ('max_tool_calls' in payload) { res.statusCode = 400; res.end(JSON.stringify({ detail: 'Unsupported parameter: max_tool_calls' })); }
      else res.end(JSON.stringify(completed()));
    });
    config.ai.webSearch = true; config.ai.direct.maxToolCallsSupported = false;
    expect((await bridge.sendPrompt({ text: 'Q', historyContextLines: ['PRIVATE_OLD_HISTORY'] })).text).toBe('OK');
    expect(calls).toBe(1); expect(payload).not.toHaveProperty('max_tool_calls');
    expect(payload.tools).toEqual([{ type: 'web_search', search_context_size: 'low' }]);
    expect(payload).toMatchObject({ reasoning: { effort: 'high' }, max_output_tokens: 4096, stream: false, store: false });
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_OLD_HISTORY');
  });
  it.each([
    [{ detail: 'Unsupported parameter: max_tool_calls' }, 'UNSUPPORTED_MAX_TOOL_CALLS'],
    [{ error: { message: "Unsupported parameter: 'max_tool_calls'." } }, 'UNSUPPORTED_MAX_TOOL_CALLS'],
    [{ error: { code: 'unsupported_parameter', param: 'max_output_tokens', message: 'PRIVATE_PROVIDER_DETAIL' } }, 'UNSUPPORTED_MAX_OUTPUT_TOKENS'],
    [{ error: { code: 'unsupported_parameter', param: 'PRIVATE_PARAMETER', message: 'PRIVATE_PROVIDER_DETAIL' } }, 'HTTP_400'],
    [{ detail: 'Unsupported parameter: max_tool_calls PRIVATE_PROVIDER_DETAIL' }, 'HTTP_400'],
  ])('records fixed unsupported-parameter diagnostics without replay, automatic downgrade or provider-text leakage', async (error, code) => {
    let calls = 0;
    const { bridge, config, diagnostics } = await fixture((_, res) => {
      calls++; res.statusCode = 400; res.end(JSON.stringify(error));
    });
    await expect(bridge.sendPrompt({ text: 'PRIVATE_QUESTION' })).rejects.toMatchObject({ stage: 'http_status', code, httpStatus: 400, retryable: false });
    expect(calls).toBe(1); expect(config.ai.direct.maxToolCallsSupported).toBe(true);
    const log = JSON.stringify(diagnostics.status());
    expect(log).not.toMatch(/PRIVATE_|test-only-key|Unsupported parameter:/);
    if (code.startsWith('UNSUPPORTED_')) expect(log).toContain('upstream_request_validation');
  });
  it('suppresses unsolicited annotation and body source URLs without disabling search or dropping the answer', async () => {
    const { bridge } = await fixture((_, res) => {
      const value = completed('回答正文。\n\n来源：\nhttps://example.org/body');
      (value.output[0]!.content[0] as any).annotations = [{type:'url_citation',url:'https://example.org/annotation'}];
      res.end(JSON.stringify(value));
    });
    expect((await bridge.sendPrompt({text:'分析这件事'})).text).toBe('回答正文。');
    expect((await bridge.sendPrompt({text:'给我来源'})).text).toContain('https://example.org/annotation');
    expect((await bridge.sendPrompt({text:'给我官网地址'})).text).not.toContain('https://example.org/annotation');
    expect((await bridge.sendPrompt({text:'给结论，不要来源链接'})).text).not.toContain('https:');
  });
  it('adds global history/style guidance even for blank style, while preserving current material and request budgets', () => {
    const c = loadConfig({});
    const p = buildDirectRequest(c,{text:'CURRENT',systemPrompt:'SELECTED_STYLE',contextLines:['CURRENT_ATTACHMENT'],
      historyContextLines:[JSON.stringify([{at:Date.now(),user:'OLD_FACT',assistant:'OLD_TONE'}])],includeHistory:true});
    const raw=JSON.stringify(p.body);
    expect(raw).toContain('旧助手回复'); expect(raw).toContain('不是文风示范'); expect(raw).toContain('本轮默认不显示来源链接');
    expect(raw).toContain('SELECTED_STYLE'); expect(raw).toContain('OLD_FACT'); expect(raw).toContain('CURRENT_ATTACHMENT');
    expect(p.stats.historyChars).toBeLessThanOrEqual(3000); expect(p.stats.inputChars).toBeLessThanOrEqual(10000);
    expect(p.stats.inputBytes).toBeLessThanOrEqual(20000);
  });
  it('does not follow redirects or replay the credential to another host', async () => {
    let calls = 0; const { bridge } = await fixture((_, res) => { calls++; res.writeHead(302, { location: 'https://example.invalid' }); res.end(); });
    await expect(bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'HTTP_302' }); expect(calls).toBe(1);
  });
  it('selects explicit final messages only, discards process/analysis/unphased duplicates and their sources', async () => {
    const {bridge,diagnostics}=await fixture((_,res)=>res.end(JSON.stringify({status:'completed',output:[
      {type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'PROCESS_ONLY',annotations:[{type:'url_citation',url:'https://example.org/process'}]}]},
      {type:'message',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'HIDDEN_ANALYSIS'}]},
      {type:'message',role:'assistant',content:[{type:'output_text',text:'UNPHASED_DUPLICATE'}]},
      {type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'FINAL_ONLY'}]},
    ]})));
    expect((await bridge.sendPrompt({text:'给来源'})).text).toBe('FINAL_ONLY');
    expect(JSON.stringify(diagnostics.status())).toContain('commentaryExcluded');
  });
  it('supports legacy phase-less final responses and safe refusal content without retries or weakening boundaries', async () => {
    const {bridge}=await fixture((_,res)=>res.end(JSON.stringify({status:'completed',output:[
      {type:'message',role:'assistant',content:[{type:'refusal',refusal:'不能协助推断具体个人的敏感属性，但可以解释一般统计方法。'}]},
    ]})));
    expect((await bridge.sendPrompt({text:'合成边界请求'})).text).toContain('不能协助');
  });
  it.each(['commentary','analysis','unknown'])('rejects a completed response containing only %s rather than sending it as an answer', async phase=>{
    let calls=0;
    const {bridge}=await fixture((_,res)=>{calls++;res.end(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',phase,content:[{type:'output_text',text:'NOT_A_FINAL'}]}]}));});
    await expect(bridge.sendPrompt({text:'Q'})).rejects.toMatchObject({code:'NO_FINAL_ANSWER'});expect(calls).toBe(1);
  });
  it('removes only standalone process preambles for phase-less providers, preserving factual prose and code', async()=>{
    let text='我去查一下合成城市的天气。\n\n合成最终回答。';
    const {bridge}=await fixture((_,res)=>res.end(JSON.stringify(completed(text))));
    expect((await bridge.sendPrompt({text:'Q'})).text).toBe('合成最终回答。');
    text='我查了一下，以下是已经取得的结果。';expect((await bridge.sendPrompt({text:'Q'})).text).toBe(text);
    text='```text\n我去查一下合成城市。\n```';expect((await bridge.sendPrompt({text:'Q'})).text).toBe(text);
    text='我去查一下。';await expect(bridge.sendPrompt({text:'Q'})).rejects.toMatchObject({code:'NO_VALID_ANSWER'});
  });
});
