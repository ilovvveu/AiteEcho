# 通用配置与个性化边界

发行源码不带维护者的群号、QQ账号、API密钥/地址、聊天历史、风格选择或声音选择。全局角色instructions与default风格为空白；预置风格只是可选模板，不强制女性角色、亲密关系或特定称呼。

| 要调整的内容 | 配置入口 | 生效方式 |
| --- | --- | --- |
| API、模型、推理强度、超时和输入预算 | 私有.env/.env.local中的DIRECT_API_*及密钥变量 | 重启bot |
| 群/私聊、主人、允许名单、真实@策略 | ONEBOT_*，分群JSON | 环境修改后重启；部分主人命令即时生效 |
| 群内普通回复限频、特殊成员 | 分群replyLimits/memberRules，/member命令 | 命令即时并持久化；手动改文件后重启 |
| 全局角色、语气、链接显示 | BOT_REPLY_RULES_FILE，示例reply-rules.json | 每轮热加载，不重启 |
| 可选风格与自建预设 | BOT_REPLY_STYLE_DIR，UTF-8文本，/style | 文件热加载，主人按会话切换 |
| 历史保留与发送 | CONTEXT_*、DIRECT_API_SEND_HISTORY、/context | 环境修改后重启；会话命令即时 |
| 音色、TTS模型、稳定度、表达方式 | ELEVENLABS_* | 重启bot；启用前必须填写允许的voiceId |
| 群语音字数门槛 | BOT_VOICE_GROUP_MAX_CHARS，默认50 | 重启bot |
| 群语音成员/管理/主人限额 | BOT_VOICE_GROUP_MEMBER_PER_MINUTE / ADMIN_PER_MINUTE / OWNER_PER_MINUTE | 默认1/2/0，主人0表示不限；重启bot |
| 语音总字符预算、超时和大小 | BOT_VOICE_MAX_CHARS / DAILY_CHARS / TIMEOUT_MS / MAX_BYTES | 重启bot |
| OCR、文档、引用、搜索、历史分析 | ACP_*、ONEBOT_*中的各能力开关 | 默认选择性关闭，重启bot |
| 元数据日志与独立@存档 | BOT_DIAGNOSTIC_LOG、BOT_MENTION_JOURNAL_FILE | 默认空路径，启用须告知成员并控制访问 |

配置项都有安全边界：不能通过风格授予命令权限，也不能把公网管理口的鉴权、附件来源校验或付费合成保护当作个人偏好取消。私聊语音默认仅主人、真实@和白名单是防滥用机制，不绑定某个真实账号。

群语音长度门槛可以高于单次TTS预算，但若正文无法完整合成则回退文字，不截短后冒充完整语音，也不为无效长度调用付费接口。分钟额度与TTS每日保护分别计算。

这些是发行默认值，不会回写任何现有部署的私有配置。迁移旧版须明确填写DIRECT_API_MODEL、ONEBOT_OWNER_USERS、所需聊天开关，以及启用语音时的ELEVENLABS_VOICE_ID；普通用户白名单不再隐式授予主人权限。先备份并对照旧配置，不要把整个运行目录当源码上传。
