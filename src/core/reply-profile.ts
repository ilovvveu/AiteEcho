import { createHash } from 'node:crypto';

export type ReplyScene = 'chat' | 'analysis' | 'followup' | 'weather' | 'weather_clarification' | 'refusal' | 'failure';
export interface ReplyProfile { styleId: string; styleVersion: string; rulesVersion: string; scene: ReplyScene }
export function contentVersion(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 12); }

export function detectReplyScene(text: string, quotedText = ''): ReplyScene {
  if (/天气|气温|降雨|下雨|weather|forecast/iu.test(text) || /天气|气温|weather/iu.test(quotedText)) return 'weather';
  if (/^(?:继续|接着|然后|刚才|上面|之前|所以|为什么|但是|那(?:么|个|位|边|里|呢)?|这个|它|他|她|再|还记得|我(?:刚才|之前)|你(?:还记得|刚才|之前))/u.test(text.trim())) return 'followup';
  if (/分析|评价|总结|解释|比较|原理|如何|怎么|为什么/u.test(text)) return 'analysis';
  return 'chat';
}

export function isBareWeatherQuestion(text: string): boolean {
  return /^(?:(?:请问|请|帮我|麻烦)?\s*(?:查一下|查查|查下|看看|看下|查询)?\s*)?(?:今天|今日|明天|后天|现在|最近)?的?天气(?:怎么样|如何|咋样|怎样|情况|呢|点)?[?？。.!！\s]*$/u.test(text.trim());
}

export function sceneInstructions(scene: ReplyScene): string {
  const common = '当前选择的风格适用于整个回复：追问缺失信息、事实播报、解释、拒绝和失败提示都不能突然退回命令式助手口吻；表达不改变事实、权限或安全边界。不要输出查找中、我去查一下等过程句；只给本轮可用结果。';
  const specific: Record<ReplyScene, string> = {
    chat: '自然接住本轮话题，不因人设强行反问、撒娇或加入无关信息。',
    analysis: '直接解释用户关心的内容，按要求展开；严谨不等于冷硬，不附无关背景或说教。',
    followup: '优先衔接当前发言人或明确引用的话题；不把其他群友的地点、偏好或经历套到当前发言人。',
    weather: '用户询问天气数据时先确认地点与日期；缺地点只友好问一次城市，不猜位置。有明确地点或引用地点则直接核实天气，不先展开人物生平等背景。无实时查询结果不得编造预报。若只是感叹天气或闲聊，不要强行追问城市。',
    weather_clarification: '用当前风格友好地询问城市即可，不责备没给地点，不用说个城市、得看你在哪儿等命令式短句。',
    refusal: '保持必要边界，简短、有礼貌地说明不能协助的部分；可给安全替代，不指责、羞辱或对用户说教。',
    failure: '温和、准确地说明当前失败及可行的下一步；不编造成功，不暴露密钥、地址或内部正文，不要求反复重置。',
  };
  return `${common}\n${specific[scene]}`;
}

/** Local replies have no extra inference cost, and never add decoration inside diagnostic codes. */
export function localSceneReply(styleId: string, scene: 'weather_clarification' | 'failure', details = ''): string {
  if (scene === 'weather_clarification') {
    const special: Record<string,string> = {
      三无:'哪个城市的天气？',中二:'想探明哪座城市的天象？告诉我地名，晴雨之谜才能揭晓。',佛系:'先不急，想看哪个城市的天气？告诉我地名就好。',
      侦探:'线索还缺一个地点：你想查哪座城市的天气？',军师:'先确定地点，你想查哪座城市的天气？',吐槽:'天气预报也得先选地图呀，想查哪座城市？',
      吟游诗人:'你想听哪座城市今日的晴雨？告诉我地名吧。',哲学家:'天气总属于某个地方，你想问哪座城市？',
      小恶魔:'想查哪座城市的天气呀？先告诉我地名，再看看太阳躲去哪儿了。',捧哏:'好嘞，哪座城市？你给地名，我来查。',
      文言:'欲问何城天气？请告地名。',树洞:'想知道哪个城市的天气呢？你告诉我地点就好。',段子手:'天气预报还没选中地图呢，想查哪座城市？',
      毒舌:'天气也得有个地名呀，想查哪座城市？',热血:'想查哪座城市的天气？告诉我地名，我们把晴雨弄明白！',
      病娇:'想知道哪座城市的晴雨呢？告诉我地名就好。',管家:'请问您想了解哪个城市的天气？给出地名后，我来核实。',
      老师:'先补充一个信息：你想查询哪个城市的天气？',腹黑:'城市还没告诉我呢，想查哪里？',苏格拉底:'要判断天气，我们先确定地点：你指哪座城市？',
      赛博:'地点尚未选定，你想查哪座城市的天气？',
    };
    if (special[styleId]) return special[styleId];
    if (styleId === '猫娘') return '想看哪个城市的天气喵？告诉我地名，我帮你看看。';
    if (['萝莉', '元气', '软萌', '天然呆'].includes(styleId)) return '诶，想看哪个城市的天气呀？告诉我地名，我帮你看看。';
    if (styleId === '傲娇') return '想查哪个城市？告诉我吧，这次就帮你看看。';
    if (['机械', '程序员', '严谨'].includes(styleId)) return '请提供城市名称，以便查询天气。';
    if (['高冷', '三无', '极简'].includes(styleId)) return '要查哪个城市的天气？';
    if (['古风', '文言', '吟游诗人'].includes(styleId)) return '想问何处的天气？告诉我地名，我替你查一查。';
    if (styleId === '粤语') return '想睇边个城市嘅天气？讲个地名，我帮你查下。';
    if (styleId === '四川话') return '想看哪个城市的天气嘛？说个地名，我帮你查一下。';
    if (styleId === '东北老铁') return '想查哪个城市的天气呀？告诉我地名，我帮你瞅瞅。';
    if (['女仆', '执事', '管家', '客服'].includes(styleId)) return '想查询哪个城市的天气呢？提供地名后，我来帮你核实。';
    return '想看哪个城市的天气呀？告诉我地名，我帮你看看。';
  }
  const prefix = styleId === '猫娘' ? '这次没能顺利完成喵。'
    : ['萝莉', '元气', '软萌'].includes(styleId) ? '诶，这次没能顺利完成。'
      : ['机械', '严谨', '程序员', '高冷', '三无', '极简'].includes(styleId) ? '本次处理未完成。' : '这次没能顺利完成。';
  return `${prefix}\n${details}`.trim();
}
