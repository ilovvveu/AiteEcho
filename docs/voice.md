# 命令触发的语音输出

ElevenLabs是可选外部TTS，与聊天API、文字风格分开配置，默认关闭。本仓库不包含密钥、音频、克隆音色或订阅。账号是否支持模型/音色、价格及余额由部署者确认，不自动充值或换用更贵模型。

## 触发与权限

- 主人私聊 /语音 问题（或 /voice 问题）：先发送完整文字，再合成短语音；下一轮恢复文字。
- 主人私聊 /朗读 文字（或 /tts 文字）：只朗读，不调用聊天模型、不读引用附件、不写问答历史。
- 授权群须另开启 BOT_VOICE_GROUP_ENABLED=true。真实 @机器人 /语音 问题，最终答案去掉首尾空白后不超过BOT_VOICE_GROUP_MAX_CHARS（默认50）个Unicode码点时只发语音、不重复文字；超过则只发完整文字，不截短配音、不调用TTS。标点、数字、内部空格和表情都计入，复合表情可能占多个码点。
- /voice、/voice status只返回本地帮助/状态，不调用模型或TTS；群内仍须真实@。on/off不是持续语音模式，直接朗读仍仅主人私聊。

群/用户白黑名单、普通回复限频及特殊成员规则始终生效。群语音另按每群每人滚动60秒限制，默认普通成员1条、群主/管理员2条、主人无分钟限额；可通过BOT_VOICE_GROUP_MEMBER_PER_MINUTE、BOT_VOICE_GROUP_ADMIN_PER_MINUTE、BOT_VOICE_GROUP_OWNER_PER_MINUTE（0表示主人不限）调整。成功语音同时计入普通回复额度；语音额满而普通额未满时只发文字。普通额度由分群replyLimits决定，不在语音模块另送次数。

超长回答不占语音额；失败释放语音额，但已接受请求的普通额度不返还。缓存语音也占语音额。特殊成员的普通不限额不等于语音不限额，语音按真实QQ身份判定。群合成不刷新私聊独立的30秒新合成间隔。

## 配置与音色

~~~dotenv
BOT_VOICE_ENABLED=false
BOT_VOICE_GROUP_ENABLED=false
ELEVENLABS_API_KEY_FILE=/absolute/private/path/elevenlabs.key
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_v4_turbo
ELEVENLABS_STABILITY=0.5
ELEVENLABS_DELIVERY=neutral
BOT_VOICE_MAX_CHARS=300
BOT_VOICE_TIMEOUT_MS=30000
BOT_VOICE_MAX_BYTES=2097152
BOT_VOICE_DAILY_CHARS=2000
BOT_VOICE_USAGE_FILE=./data/voice-usage.json
BOT_VOICE_FFMPEG_COMMAND=ffmpeg
~~~

密钥文件仅含密钥，权限0600、非软链接、≤4096字节，放私有运行目录；也可用私有ELEVENLABS_API_KEY环境变量注入（优先于文件）。不允许通过QQ指定API地址、模型、密钥或任意本地文件。FFmpeg须自行安装，不依赖特定用户目录。

本适配通过官方Text to Dialogue WebSocket提交一次文字，收齐最终音频再交QQ，不把分块刷入群聊。启用前须填写账号允许的voiceId，未预选女声或个人音色，不随/style变化。已实现的控制包括：

- stability：0–1的稳定度。
- delivery=lively：对适配支持的v4 Turbo/v3添加[happy]音频标签；旧模型不发标签并报告neutral。内部标签不计入群语音字数门槛，但计入实际TTS与每日预算。
- 明确朗读文字可含模型支持的音频标签；属于表达引导，不保证每次情绪一致。

本适配未发送独立音高、Similarity、Style、Speed或Speaker Boost参数，不宣称这些旋钮已生效，也未开放群友上传音频克隆功能。文字风格控制内容表达，voiceId选择说话声音；状态读取或代码测试不等于音色满意。

模型、音色权限和价格可能变化，以[官方API价格](https://elevenlabs.io/pricing/api)和账号为准。协议参考：[实时对话指南](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd)、[WebSocket接口](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket)。

## 隐私、预算与失败

仅提交本轮最终正文或明确朗读文字，不提交完整聊天历史、系统提示、成员资料或原图。朗读前处理Markdown、网址、代码、CQ和常见密钥格式，但不是任意敏感信息脱敏器。云端仍可能按政策留存请求，本地不存音频不代表云端零留存。

私聊默认每次最多300字符：直接朗读超限拒绝；模型长答案只朗读有标记的短节选，完整文字保留。群聊使用可配置的完整语音字数门槛（默认50）。全进程共享单并发、失败熔断和默认每日2000字符保护，主人无分钟限额不绕过这些保护或余额。相同文字/音色/模型/稳定度可用10分钟RAM缓存，最多4条、默认≤8MiB，不建持久化音频库。

每日保护按北京时间重置，API前在0600 usage文件原子保守预占，重启不清零；失败也保留预占，因为不能确认上游是否计费。损坏/软链文件暂停新合成，缓存命中不重复预占。这是本地保护，不是提供方精确账单。

合成默认总时限30秒、音频≤2MiB，固定官方HTTPS/WSS域名，不跟随重定向、不自动重试付费合成。402或密钥/权限错误熔断后续合成，需处理账户/配置后按运维流程重启。群合成/发送失败只退回原完整文字，不重新问模型、不重试TTS；私聊已发文字则保留并附独立诊断编号。失败不伪装成功。

## 本地转码与验收

为不依赖NapCat是否支持MP3转码，bot在隔离Node子进程调用FFmpeg转为24kHz单声道PCM，再用固定silk-wasm编码Tencent SILK，通过record动作发送。子进程不继承密钥环境、无shell，仅管道传音频；FFmpeg仅允许pipe协议，解码/PCM时长/输出大小/整体耗时均受限，不接受QQ给出的路径或远程URL。

诊断阶段voice_policy、tts_request、tts_cache、qq_voice_encode、qq_voice_send、voice_output分别记录策略、合成、缓存、转码、发送与兜底。仅含字符数、大小、耗时、request ID和安全错误码，不记正文、base64、密钥或提供方原文。/status.config.voice报告实际开关、voiceId和分级限额。

发送成功要求OneBot成功状态及有效message_id，只证明收到回执，不证明手机可见、可播放或音色满意。合成、解码、SILK转换、OneBot发送与真实客户端试听分别验收。
