import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { contextPrompt, pruneContext } from './bounded-context.js';
import { continuesWeatherClarification, needsLocalWeatherClarification, selectRelevantContext } from './context-selection.js';
import type { ContextTurn } from '../types/session.js';

const query={text:'今天天气怎么样',senderId:'1',styleId:'猫娘',styleVersion:'123456789abc',scene:'weather' as const};
const turn=(user:string,assistant:string,extra:Partial<ContextTurn>={}):ContextTurn=>({at:Date.now()-1000,user:`发言人QQ:1\n${user}`,assistant,...extra});
describe('bounded relevant history without rewriting stored originals',()=>{
  it('recognizes city-only answers to a recent same-sender clarification without reviving expired or superseded questions',()=>{
    const pending=turn('今天天气怎么样','哪个城市？',{scene:'weather_clarification',topic:'weather'});
    for(const city of ['北京','我在杭州','New York','那上海呢？'])expect(continuesWeatherClarification([pending],city,'1')).toBe(true);
    for(const unrelated of ['不用了','谢谢','讲个笑话','你是谁','解释光合作用','你好'])expect(continuesWeatherClarification([pending],unrelated,'1')).toBe(false);
    expect(continuesWeatherClarification([pending],'北京','2')).toBe(false);
    expect(continuesWeatherClarification([{...pending,at:Date.now()-600001}],'北京','1')).toBe(false);
    expect(continuesWeatherClarification([pending,turn('聊别的','好')],'北京','1')).toBe(false);
  });
  it('drops unrelated prior replies, excludes other members locations and retains same-sender weather facts',()=>{
    const old=[turn('敏感问题','无法据此判断。'),turn('北京今天天气','北京天气参考', {senderId:'2',topic:'weather'}),turn('上海天气','上海天气参考',{topic:'weather'})];
    const selected=selectRelevantContext(old,query);
    expect(selected).toHaveLength(1);expect(selected[0]!.assistant).toContain('上海天气参考');expect(JSON.stringify(selected)).not.toContain('北京');
    expect(old[2]!.assistant).toBe('上海天气参考');
  });
  it('keeps related shared-group facts and same-sender followups, but only among the latest bounded candidates',()=>{
    const old=[turn('天际属于诺德人','先前的口号回答',{senderId:'2'}),turn('其他新话题','无关答案')];
    expect(selectRelevantContext(old,{...query,text:'天际属于诺德人',scene:'chat'})).toHaveLength(1);
    expect(selectRelevantContext(old,{...query,text:'继续',scene:'followup'})).toHaveLength(1);
    const interleaved=[turn('我的问题','我的回答'),turn('其他人的问题','别人的回答',{senderId:'2'}),turn('第三人的问题','第三人的回答',{senderId:'3'})];
    expect(selectRelevantContext(interleaved,{...query,text:'继续',scene:'followup'})[0]!.assistant).toContain('我的回答');
    const limits={...loadConfig({}).context,promptTurns:1,promptChars:3000};
    expect(contextPrompt(old,limits,Date.now(),{...query,text:'天际属于诺德人',scene:'chat'})).toEqual([]);
  });
  it('preserves validated trace metadata on pruning and caps mismatched old prose only in uploaded reference',()=>{
    const data=turn('上海天气','答'.repeat(900),{senderId:'1',styleId:'机械',styleVersion:'aaaaaaaaaaaa',rulesVersion:'bbbbbbbbbbbb',scene:'weather',topic:'weather'});
    const limits=loadConfig({}).context, retained=pruneContext([data],limits);
    expect(retained[0]).toMatchObject({styleId:'机械',scene:'weather',rulesVersion:'bbbbbbbbbbbb'});
    const lines=contextPrompt(retained,{...limits,promptChars:3000},Date.now(),query);
    expect(lines.join('\n').length).toBeLessThanOrEqual(3000);expect(lines.join('\n')).toContain('非本轮语气示例');
    expect(retained[0]!.assistant.length).toBe(900);
  });
  it('asks locally only without a usable city or quote, and never treats others city as this members preference',()=>{
    expect(needsLocalWeatherClarification('今天天气怎么样',[],false)).toBe(true);
    expect(needsLocalWeatherClarification('今天天气怎么样',[],true)).toBe(false);
    const lines=['历史',JSON.stringify([turn('上海天气','上海天气参考')])];
    expect(needsLocalWeatherClarification('今天天气怎么样',lines,false)).toBe(false);
    expect(needsLocalWeatherClarification('今天天气真好',[],false)).toBe(false);
  });
});
