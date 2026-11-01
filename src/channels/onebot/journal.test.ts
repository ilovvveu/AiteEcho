import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { OneBotGateway } from './client.js';

it('observes acknowledgements, rejection, missing ACK and transport errors while only accepting a real ACK', async () => {
  const observed = vi.fn();
  const gateway = new OneBotGateway(loadConfig({}), pino({ enabled: false }), undefined, undefined, undefined, observed) as any;
  gateway.transport = { sendAction: vi.fn().mockResolvedValueOnce({ status: 'ok', retcode: 0, data: { message_id: 1 } })
    .mockResolvedValueOnce({ status: 'failed', retcode: 100, wording: 'PRIVATE_PROVIDER_ERROR' })
    .mockResolvedValueOnce({ status: 'ok', retcode: 0 })
    .mockRejectedValueOnce(Object.assign(new Error('PRIVATE_TRANSPORT_MESSAGE'), { code: 'ECONNRESET' })) };
  const context = { chatType: 'group', targetId: '100', correlationId: 'trace', purpose: 'reply' };
  await expect(gateway.sendText(context, 'A')).resolves.toBe('1');
  await expect(gateway.sendText(context, 'B')).rejects.toMatchObject({ code: 'ONEBOT_SEND_REJECTED', retcode: 100, deliveryUnknown: false });
  await expect(gateway.sendText(context, 'C')).rejects.toMatchObject({ code: 'ONEBOT_SEND_UNCONFIRMED', deliveryUnknown: true });
  await expect(gateway.sendText(context, 'D')).rejects.toThrow('PRIVATE_TRANSPORT_MESSAGE');
  expect(observed.mock.calls.map(([event]) => event.outcome)).toEqual(['acknowledged', 'rejected', 'unconfirmed', 'failed']);
  expect(observed.mock.calls[1]![0]).toMatchObject({ retcode: 100 });
  expect(observed.mock.calls[3]![0]).toMatchObject({ errorCode: 'ECONNRESET' });
  expect(JSON.stringify(observed.mock.calls)).not.toContain('PRIVATE_');
});
it.each([{ data: { message_id: '' } }, { data: { message_id: 0 } }, { data: { message_id: NaN } },
  { status: 'async', data: { message_id: 1 } }])('rejects an invalid or async message ACK: %j', async response => {
  const sent = vi.fn(), observed = vi.fn();
  const gateway = new OneBotGateway(loadConfig({}), pino({ enabled: false }), sent, undefined, undefined, observed) as any;
  gateway.transport = { sendAction: vi.fn().mockResolvedValue(response) };
  await expect(gateway.sendText({ chatType: 'direct', targetId: '1' }, 'PRIVATE_TEXT')).rejects.toMatchObject({ code: 'ONEBOT_SEND_UNCONFIRMED' });
  expect(sent).not.toHaveBeenCalled();
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unconfirmed', errorCode: 'ONEBOT_SEND_UNCONFIRMED' }));
  expect(gateway.transport.sendAction.mock.calls[0][2]).toBe(30_000);
});
it('does not send later chunks after a rejection or count it as successful delivery', async () => {
  const sent = vi.fn();
  const gateway = new OneBotGateway(loadConfig({}), pino({ enabled: false }), sent) as any;
  gateway.transport = { sendAction: vi.fn().mockResolvedValue({ status: 'failed', retcode: 100, data: { message_id: 7 } }) };
  await expect(gateway.sendPlannedPayload({ chatType: 'group', targetId: '1' }, { actions: [
    { kind: 'text', text: 'A' }, { kind: 'text', text: 'B' },
  ] })).rejects.toMatchObject({ code: 'ONEBOT_SEND_REJECTED' });
  expect(gateway.transport.sendAction).toHaveBeenCalledTimes(1); expect(sent).not.toHaveBeenCalled();
});
it('does not turn successful delivery into a failure if an observer fails', async () => {
  const gateway = new OneBotGateway(loadConfig({}), pino({ enabled: false }), undefined, undefined, undefined, async () => { throw Error('disk'); }) as any;
  gateway.transport = { sendAction: vi.fn().mockResolvedValue({ retcode: 0, data: { message_id: 7 } }) };
  await expect(gateway.sendText({ chatType: 'group', targetId: '100' }, 'A')).resolves.toBe('7');
});
