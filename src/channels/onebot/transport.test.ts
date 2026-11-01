import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { startForwardWsTransport, startReverseWsTransport } from './transport.js';

function sendFrames(socket: WebSocket, echo: string) {
  const data = Buffer.from('synthetic-image');
  for (const frame of [{ data_type: 'file_info', file_size: data.length }, { data_type: 'file_chunk', index: 0, size: data.length, data: data.toString('base64') }, { data_type: 'file_complete', total_bytes: data.length, total_chunks: 1 }]) socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: frame }));
}

describe('OneBot stream transport', () => {
  it('contains malformed shapes and rejected event handlers without an unhandled rejection or losing the socket', async () => {
    const patches: any[] = [], processed = vi.fn().mockRejectedValueOnce(Error('PRIVATE_HANDLER_ERROR')).mockResolvedValue(undefined);
    const transport = await startReverseWsTransport({ host: '127.0.0.1', port: 0, path: '/onebot', onEvent: processed, onStatus: p => patches.push(p) });
    const address = transport.server.address(); if (!address || typeof address === 'string') throw Error('address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/onebot`);
    socket.on('message', raw => { const req = JSON.parse(raw.toString()); socket.send(JSON.stringify({ echo: req.echo, status: 'ok', retcode: 0, data: { online: true } })); });
    try {
      await once(socket, 'open'); socket.send('null'); socket.send('[]'); socket.send('{broken'); socket.send(JSON.stringify({ post_type: 'message' }));
      for (let i = 0; i < 30 && !patches.some(p => p.lastError === 'ONEBOT_EVENT_HANDLER_FAILED'); i++) await new Promise(r => setTimeout(r, 5));
      expect(patches).toEqual(expect.arrayContaining([expect.objectContaining({ lastError: 'ONEBOT_EVENT_HANDLER_FAILED' })]));
      socket.send(JSON.stringify({ post_type: 'meta_event' }));
      expect((await transport.sendAction('get_status', {}, 1000)).data?.online).toBe(true);
      expect(processed).toHaveBeenCalledTimes(2); expect(JSON.stringify(patches)).not.toContain('PRIVATE_HANDLER_ERROR');
      expect(transport.isReady()).toBe(true);
    } finally { socket.close(); await transport.close(); }
  });
  it('keeps all chunks for the same echo, handles concurrent regular actions, and times out safely', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });await once(server, 'listening');
    const address = server.address();if (!address || typeof address === 'string') throw new Error('unexpected address');
    let socket: WebSocket | undefined;
    server.on('connection', s => {socket = s;s.on('message', raw => {const req = JSON.parse(raw.toString());if (req.action === 'get_status') s.send(JSON.stringify({ echo: req.echo, retcode: 0, data: { online: true } }));else if(req.params.file === 'ok.image')sendFrames(s,req.echo);});});
    let ready!: () => void;const connected = new Promise<void>(r => {ready = r;});
    const transport = startForwardWsTransport({ url: `ws://127.0.0.1:${address.port}`, onEvent: () => {}, onStatus: patch => {if(patch.connected)ready();} });
    try {
      await connected;
      const [image,status] = await Promise.all([transport.readImageStream!('ok.image',1024),transport.sendAction('get_status',{})]);
      expect(Buffer.from(image,'base64').toString()).toBe('synthetic-image');expect(status.data?.online).toBe(true);
      await expect(transport.readImageStream!('timeout.image',1024,100)).rejects.toThrow('timed out');
      await expect(transport.sendAction('unanswered_history', {}, 30)).rejects.toMatchObject({ code: 'ONEBOT_ACTION_TIMEOUT', deliveryUnknown: true });
      expect((await transport.sendAction('get_status', {}, 1000)).data?.online).toBe(true);
      const pending = transport.readImageStream!('disconnect.image',1024);socket!.close();await expect(pending).rejects.toThrow('websocket closed');
    } finally {await transport.close();await new Promise<void>(r=>server.close(()=>r()));}
  });
  it('supports the deployed reverse-WebSocket mode without adding a new listener', async () => {
    const transport = await startReverseWsTransport({ host:'127.0.0.1',port:0,path:'/onebot',accessToken:'test-only',onEvent:()=>{} });
    const address = transport.server.address();if(!address || typeof address === 'string')throw new Error('unexpected address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/onebot`,{headers:{Authorization:'Bearer test-only'}});
    socket.on('message',raw=>{const req=JSON.parse(raw.toString());sendFrames(socket,req.echo);});
    try {await once(socket,'open');expect(await transport.readImageStream!('ok.image',1024)).toBe(Buffer.from('synthetic-image').toString('base64'));}
    finally{socket.close();await transport.close();}
  });
  it('keeps a replacement reverse connection usable after the old socket closes, without replaying old actions', async () => {
    const onEvent = vi.fn(), patches: any[] = [];
    const transport = await startReverseWsTransport({ host: '127.0.0.1', port: 0, path: '/onebot', onEvent, onStatus: p => patches.push(p) });
    const address = transport.server.address(); if (!address || typeof address === 'string') throw Error('address');
    const url = `ws://127.0.0.1:${address.port}/onebot`;
    const old = new WebSocket(url); let replacement: WebSocket | undefined;
    try {
      await once(old, 'open');
      const oldClosed = once(old, 'close');
      const pending = expect(transport.sendAction('old_unanswered', {}, 1000)).rejects.toMatchObject({ code: 'ONEBOT_CONNECTION_CLOSED' });
      replacement = new WebSocket(url);
      const actions: string[] = [];
      replacement.on('message', raw => { const req = JSON.parse(raw.toString()); actions.push(req.action);
        replacement!.send(JSON.stringify({ echo: req.echo, status: 'ok', retcode: 0, data: { online: true } })); });
      await once(replacement, 'open'); old.close(); await oldClosed; await pending;
      expect(transport.isReady()).toBe(true);
      expect((await transport.sendAction('get_status', {}, 1000)).data?.online).toBe(true);
      expect(actions).toEqual(['get_status']); expect(patches.filter(p => p.connected !== undefined).at(-1).connected).toBe(true);
    } finally { old.close(); replacement?.close(); await transport.close(); }
  });
});
