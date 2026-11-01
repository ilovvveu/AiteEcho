import { describe, expect, it } from 'vitest';
import { contentVersion, detectReplyScene, isBareWeatherQuestion, localSceneReply, sceneInstructions } from './reply-profile.js';
import { readdirSync } from 'node:fs';

describe('full-scene style profiles', () => {
  it.each(['今天天气怎么样','今日天气点','请问天气如何？','天气','明天的天气呢'])('only recognizes unambiguous missing-city requests: %s', text => {
    expect(isBareWeatherQuestion(text)).toBe(true);
  });
  it.each(['北京今天天气','今天天气真好','马斯克老家','分析天气模型','今天天气怎么样，附来源'])('does not intercept specific or more complex requests: %s', text => {
    expect(isBareWeatherQuestion(text)).toBe(false);
  });
  it('carries weather intent through an explicit quote and preserves distinct voices', () => {
    expect(detectReplyScene('马斯克老家','想看哪个城市的天气？')).toBe('weather');
    expect(localSceneReply('猫娘','weather_clarification')).toContain('喵');
    expect(localSceneReply('萝莉','weather_clarification')).toContain('诶');
    expect(localSceneReply('机械','weather_clarification')).not.toMatch(/喵|呀|诶/);
    expect(localSceneReply('高冷','weather_clarification')).toBe('要查哪个城市的天气？');
    expect(localSceneReply('邻家姐姐','weather_clarification')).not.toMatch(/说个城市|得看你在哪儿/);
    expect(localSceneReply('猫娘','failure','HTTP_401')).toContain('\nHTTP_401');
  });
  it('applies style to clarification, facts, analysis and refusals without changing boundaries', () => {
    for(const scene of ['chat','analysis','followup','weather','weather_clarification','refusal','failure'] as const){
      const text=sceneInstructions(scene); expect(text).toContain('当前选择的风格'); expect(text).toContain('事实、权限或安全边界');
    }
    expect(contentVersion('A')).toMatch(/^[a-f0-9]{12}$/); expect(contentVersion('A')).not.toBe(contentVersion('B'));
  });
  it('provides bounded weather clarification and failure wording for all 43 installed preset IDs without touching codes',()=>{
    const ids=readdirSync('examples/styles').filter(n=>n.endsWith('.txt')).map(n=>n.slice(0,-4));expect(ids).toHaveLength(43);
    for(const id of ids){
      const clarification=localSceneReply(id,'weather_clarification');expect(clarification.length).toBeGreaterThan(3);expect(clarification.length).toBeLessThan(100);
      expect(localSceneReply(id,'failure','HTTP_401\ntrace-123')).toContain('HTTP_401\ntrace-123');
    }
  });
});
