import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { OneBotGateway } from './client.js';
import * as codec from '../../core/voice-codec.js';
it.each(['direct','group'] as const)('sends %s MP3 bytes as one record segment, without accompanying text, and requires an acknowledged message ID',async(chatType)=>{
  const silk=Buffer.from('\x02#!SILK_V3TEST');const encode=vi.spyOn(codec,'encodeQqVoice').mockResolvedValue(silk);
  const gateway=new OneBotGateway(loadConfig({}),pino({enabled:false})) as any;
  const sendAction=vi.fn().mockResolvedValueOnce({status:'ok',retcode:0,data:{message_id:731}}).mockResolvedValueOnce({status:'failed',retcode:1,data:{}}).mockResolvedValueOnce({status:'ok',retcode:0,data:{}});
  gateway.transport={sendAction};const context={chatType,targetId:'1',replyToId:'2'};
  await expect(gateway.sendVoice(context,Buffer.from('ID3\x04TEST'))).resolves.toBe('731');
  expect(sendAction.mock.calls[0]).toEqual([chatType==='group'?'send_group_msg':'send_private_msg',{
    ...(chatType==='group'?{group_id:'1'}:{user_id:'1'}),message:[{type:'record',data:{file:`base64://${silk.toString('base64')}`,name:'reply.silk'}}],
  },30_000]);
  await expect(gateway.sendVoice(context,Buffer.from('ID3\x04TEST'))).rejects.toThrow('acknowledged');
  await expect(gateway.sendVoice(context,Buffer.from('ID3\x04TEST'))).rejects.toThrow('acknowledged');
  await expect(gateway.sendVoice(context,Buffer.from('https://example.org/test.mp3'))).rejects.toThrow('invalid');
  expect(sendAction).toHaveBeenCalledTimes(3);
  encode.mockRejectedValueOnce(new Error('transcode failed'));
  await expect(gateway.sendVoice(context,Buffer.from('ID3\x04TEST'))).rejects.toThrow('transcode');expect(sendAction).toHaveBeenCalledTimes(3);
  encode.mockRestore();
});
