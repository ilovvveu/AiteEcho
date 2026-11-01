# 配置说明

单次语音输出（ElevenLabs，默认关闭）见[语音配置与权限](voice.md)。私聊仅主人可用；授权群须另行启用群语音。语音配置独立于文字风格与聊天API，不会因切换文字风格自动换声线。

项目启动时会自动读取项目根目录下的 `.env`。

如果同时存在 `.env.local`，同名项会覆盖 `.env`。

`AI_BACKEND=direct`为无需Codex进程的独立API后端，时限、全输入预算与诊断日志见[独立API后端](direct-api.md)。下文有关创建/关闭ACP会话的说明仅适用于ACP后端；直连默认不自动携带旧问答，主人主动开启后才采用6次/3000历史字符，并另设10000字符/20000字节的全输入文字预算。

## 有界上下文与回复风格

`CONTEXT_BOUNDED=true` 时，本机仅保留成功发送后的最近100次问答（一次用户提问和一次机器人最终回复为一条），并淘汰超过24小时的数据。另设120000字符的序列化大小上限；条数、时间、大小任一达到就从最旧记录开始移除。每条用户文字最多2000字符、回复最多4000字符；附件/引用只保留短节选，图片只保留当轮文字解读，不重发旧图片原件。

ACP兼容路径未显式配置时，历史最多12次问答/8000字符；仓库安全示例收紧为6次/3000字符。启用有界上下文后，ACP每轮新建并在结束后关闭会话，避免底层额外夹带旧会话、工具输出和历史图片。上述上限仅针对历史文字，当前问题、附件、系统/工具说明及搜索结果仍额外计入输入。ACP长问题正文上限8000字符，截断会标注。直连后端不创建ACP会话；历史默认关闭，开启后还受最多6轮/3000历史字符及全输入预算约束。无需额外模型摘要调用。

示例配置：`CONTEXT_MAX_TURNS=100`、`CONTEXT_MAX_AGE_HOURS=24`、`CONTEXT_MAX_STORED_CHARS=120000`、`CONTEXT_PROMPT_TURNS=6`、`CONTEXT_PROMPT_CHARS=3000`。启动及每轮发送前修剪，后台每10分钟检查；`/reset`同时清除当前会话的受限文字记录。群内共享上下文、各私聊独立。成功写入的上下文保存在现有session store；file模式原子替换且权限0600。独立@存档不受这些清理规则影响。

新会话ID在模型调用前登记；结束后仅清理该机器人本轮创建的精确ID对应rollout文件，禁止遍历软链接或清理其他会话。清理失败登记后重试，积压100项后停止创建新会话并报错。这里不清除QQ原生聊天记录、历史恢复备份、Codex运行日志数据库或未被本功能创建的旧诊断会话。旧运行会话可在停机时用`scripts/migrate-bounded-context.mjs`迁移：仅导入已完成问答，按相同上限修剪，将原rollout留在指定库外恢复点，再移出活动存储；不调用模型。

`BOT_REPLY_STYLE_FILE`指定独立UTF-8纯文本风格预设，示例见`examples/reply-style.txt`。可编辑语气、称呼、篇幅与表达习惯；下一次回复自动检测修改，无需重启。文件最大16KiB且正文最多4000字符；空文件关闭风格追加，缺失/非法文件沿用上次有效内容。风格仅附加到表达要求，群权限、限频与账号由原程序控制。无需额外模型调用，但预设文字本身属于每次输入的一部分。

### 多套风格与主人命令

所有风格（含空白default）另受下文“全局回复规则”控制。切换风格不清理事实记忆，但旧助手回复只用于内容衔接，不作为当前语气示范。

当前内置43套（含空白default），分类与全部名称见[回复风格目录](style-catalog.md)。每次只加载选中的一套，不会把整个风格库放进模型上下文。

配置`BOT_REPLY_STYLE_DIR`后优先使用多预设模式，忽略上述固定风格文件。目录内每个`风格名.txt`是一套UTF-8纯文本预设；`default.txt`初始为0字节，表示不添加额外风格，未选择过的所有会话默认使用它。模板在`examples/styles/`，附带可选的`自然.txt`，不会自动选中它。

仅`ONEBOT_OWNER_USERS`中的本人可使用以下命令（群内仍须真实@机器人，QQ群主/管理员也不能代替本人）：

- `/style`或`/style list`：当前会话的选择和可用列表。
- `/style 自然`：切换当前群或当前私聊为“自然”。
- `/style default`或`/style reset`：恢复默认空白预设。
- `/style show`：显示当前预设正文。

切换通过本地代码完成，不调用模型。选择保存在`BOT_REPLY_STYLE_STATE_FILE`（默认`./data/reply-styles.json`），按群和私聊分别持久化，0600原子写入，并保留一份`.bak`；不与聊天上下文共用存储，因此`/reset`、过期清理和正常重启不重置选择。新增符合命名规则的`.txt`文件后，列表立即可见；已选文件修改后下一次回复自动生效。风格名允许1–40个中文/其他字母、数字、下划线或连字符，`list/show/reset`为命令保留字，不作为文件名；禁止路径、软链接和超限正文。找不到或无法保存时不会改变原选择。预设仅用于表达，不能给其他群友开放设置权限。

### 全局回复规则

full-scene-v3另有统一的场景规则：当前风格贯穿追问、事实回答、解释、拒绝及失败，不因任务严谨就退回冷硬口吻；机械/高冷仍保留自身低情绪特征。简单缺城市天气可本地澄清而不耗模型请求，复杂或引用场景不被拦截；历史只从最新有限候选筛选相关项，不清空本地历史。消息phase与诊断元数据说明见[独立API后端](direct-api.md#全场景风格与最终答案)。

`BOT_REPLY_RULES_FILE`指定独立的本机JSON文件，示例见`examples/reply-rules.json`，运行部署使用`config/reply-rules.json`。对全部群聊/私聊、全部风格及空白default生效；只控制输出表达，不改变权限、限频、模型或强度。每轮读取、修改下次生效，不必重启。文件禁止软链接、最大16KiB，额外instructions最多1000字符；损坏时沿用本进程最后有效配置，首次无有效配置时用on_request安全默认。状态接口config.replyRules显示生效模式。

- `version`：1。
- `sourceLinks`：`on_request`默认不主动附来源链接；当本条问题明确要求来源、出处、链接、官网或下载地址时允许提供；明确“不要链接”优先。`always`每轮允许来源，`never`每轮隐藏新增网页链接。
- `instructions`：所有风格共用的简短表达规则，可逐步扩展。不要放密钥、账号或完整聊天。

全局instructions示例默认为空，不绑定性别、角色、亲密互动或称呼；部署者可自行填写通用表达规则或角色设定。空白default不附加风格，43套风格仅为可选模板，不自动选中。角色设置不授予操作权限，真实身份和安全边界不靠改提示词绕过。

全局规则是每轮注入的受信任本地配置，不靠历史记住。/reset、过期清理及/style default不删除配置文件。修改JSON/已选风格文件可热更新；代码验证不能保证模型每次表达一致，真实效果仍须体验。

同时处理模型正文HTTP(S)/www链接、Markdown链接和接口来源注释，不只是提示模型；默认保留正文事实、链接文字标签、代码块/行内代码与用户本条已提供的网址。显式索要来源时最多补5条接口已返回的有效来源URL，不编造；只索要官网/下载等功能网址时保留所需网址，但不额外追加参考来源列表。请求仅凭当前提问判断，不接受引用附件/历史问答代替当前用户要求；“联网搜索”本身不等于索要链接。仍可搜索核实，必要时说明信息日期和不确定性。空白风格不关闭全局规则；不修改或批量删除本地旧记录中的链接。

## `.env` 主要配置

### 服务本身

| 配置项 | 说明 |
| --- | --- |
| `BOT_HOST` | HTTP监听地址，默认127.0.0.1；非数字回环地址须配置强管理token |
| `BOT_ADMIN_TOKEN` | 可选独立管理token，24–512个非空白字符，不得与OneBot token相同；配置后本机访问也须Bearer鉴权 |
| `BOT_PORT` | HTTP 服务端口 |
| `LOG_LEVEL` | 日志级别 |
| `DATA_DIR` | 数据目录 |
| `SESSION_STORE` | `file`、`redis` 或 `postgres` |
| `SESSION_FILE_PATH` | 会话持久化文件路径 |
| `SESSION_TTL_MINUTES` | 会话过期时间 |
| `REDIS_URL` | `SESSION_STORE=redis` 时的 Redis 连接串 |
| `REDIS_KEY_PREFIX` | Redis key 前缀 |
| `POSTGRES_URL` | `SESSION_STORE=postgres` 时的 Postgres 连接串 |
| `POSTGRES_TABLE` | Postgres session 表名，默认 `qq_ai_bot_sessions` |
| `APP_GIT_COMMIT` | 可选，当前运行版本对应的 git commit |
| `APP_BUILD_REF` | 可选，构建标识、镜像 tag 或部署版本号 |

### QQ / OneBot 11

| 配置项 | 说明 |
| --- | --- |
| `ONEBOT_MODE` | `forward` 或 `reverse` |
| `ONEBOT_ACCESS_TOKEN` | OneBot认证token；非回环反向监听强制使用24字符以上非占位随机值 |
| `ONEBOT_FORWARD_WS_URL` | forward 模式地址 |
| `ONEBOT_REVERSE_WS_HOST` | reverse WS监听地址，默认127.0.0.1；跨容器监听需强token |
| `ONEBOT_REVERSE_WS_PORT` | reverse WS 监听端口 |
| `ONEBOT_REVERSE_WS_PATH` | reverse WS 路径 |
| `ONEBOT_ALLOW_GROUP` | 是否响应群聊 |
| `ONEBOT_REQUIRE_MENTION_IN_GROUP` | 群聊是否必须 `@` |
| `ONEBOT_ALLOW_PRIVATE` | 是否响应私聊 |
| `ONEBOT_ALLOW_GROUP_COMMANDS_WITHOUT_MENTION` | 群聊命令是否允许不 `@` 直接执行 |
| `ONEBOT_ALLOWED_GROUPS` | 群白名单，逗号分隔 |
| `ONEBOT_BLOCKED_GROUPS` | 群黑名单，逗号分隔 |
| `ONEBOT_ALLOWED_USERS` | 用户白名单，逗号分隔 |
| `ONEBOT_OWNER_USERS` | 明确指定机器人主人账号，逗号分隔；默认无人，不从普通用户白名单推断主人身份 |
| `ONEBOT_BLOCKED_USERS` | 用户黑名单，逗号分隔 |
| `ONEBOT_COMMAND_PREFIX` | 命令前缀，默认 `/` |
| `ONEBOT_GROUP_CONFIG_FILE` | 分群配置文件 |
| `ONEBOT_PROGRESS_MODE` | `off` 或 `message` |
| `ONEBOT_OUTBOUND_MAX_TEXT_LENGTH` | 单条消息最大文本长度 |
| `ONEBOT_INBOUND_DEDUPE_WINDOW_MS` | 轻量入站去重窗口，默认 120000 ms |
| `ONEBOT_INBOUND_DEDUPE_MAX_ENTRIES` | 入站去重缓存上限，默认 2048 |
| `ONEBOT_INBOUND_IMAGE_LOCAL_ROOTS` | 允许读取的 OneBot 本地图片缓存根目录，逗号分隔；默认空即完全禁止 |
| `ONEBOT_INBOUND_IMAGE_STREAM` | 默认 `false`；通过现有已认证 OneBot 连接读取 NapCat 图片流。须以 `get_msg` 核验当前消息或一层引用中真实图片段及所属会话，限制大小、顺序和超时，不放宽 URL/本地路径安全边界 |
| `ONEBOT_RESOLVE_REPLIES` | 获取一层引用正文/图片/文档；默认 `false`，原消息须属于当前群或私聊 |
| `ONEBOT_READ_GROUP_HISTORY` | 默认 `false`；按需读取当前群指定成员的近期文字发言并分析，沿用群/@/用户/限频校验，不后台采集 |
| `NAPCAT_WEBUI_TOKEN` | macOS NapCat helper 使用的 WebUI token |
| `QQ_APP_PATH` | macOS helper 使用的 QQ.app 路径 |

### ACP / Agent

| 配置项 | 说明 |
| --- | --- |
| `ACP_AGENT_COMMAND` | agent 可执行文件，例如 `node`、`traex` 或你的自定义命令 |
| `ACP_AGENT_ARGS_JSON` | 启动参数，推荐写合法 JSON 数组 |
| `ACP_AGENT_WORKDIR` | agent 工作目录 |
| `ACP_CLIENT_NAME` | ACP client name |
| `ACP_REUSE_SESSION` | 是否复用远端 session |
| `ACP_DEFAULT_SYSTEM_PROMPT` | 默认 system prompt |
| `ACP_VERBOSE_MODE` | `normal` / `verbose` / `debug` |
| `ACP_PERMISSION_STRATEGY` | `allow_once` / `allow_always` / `cancel` |
| `ACP_PROGRESS_THROTTLE_MS` | 进度消息最小间隔 |
| `ACP_MAX_PROGRESS_UPDATES` | 单轮最多进度更新次数 |
| `ACP_MAX_INBOUND_IMAGES` | 单轮最多处理图片数 |
| `ACP_MAX_INBOUND_IMAGE_BYTES` | 单张图片大小上限 |
| `ACP_LOCAL_VISION_OCR` | macOS 上是否启用本机 Vision OCR，默认 `false` |
| `ACP_LOCAL_VISION_OCR_COMMAND` | 可选，预编译 Vision OCR 可执行文件的绝对路径；留空时解释执行仓库 Swift 脚本 |
| `ACP_LOCAL_VISION_OCR_TIMEOUT_MS` | 每张图片的本机 OCR 超时 |
| `ACP_LOCAL_VISION_OCR_MAX_CHARS` | 单轮最多附加给 agent 的 OCR 字符数 |
| `ACP_READ_DOCUMENTS` | 启用本机只读文档提取，默认 `false` |
| `ACP_DOCUMENT_PYTHON_COMMAND` | 含 pypdf、python-docx、openpyxl 的 Python 可执行文件，默认 `python3` |
| `ACP_MAX_INBOUND_DOCUMENTS` | 每轮最多文件数量，默认 2，范围 1–5 |
| `ACP_MAX_INBOUND_DOCUMENT_BYTES` | 每文件下载大小上限，默认且最高 10 MiB |
| `ACP_MAX_DOCUMENT_CHARS` | 每轮附件文字总上限，默认 20000，最高 60000 |
| `ACP_DOCUMENT_TIMEOUT_MS` | 单文件下载/解析各自超时，默认 20000 ms |
| `ACP_WEB_SEARCH` | 为 codex-acp 子进程设置 `web_search=live`，默认 `false`；需要当前接口支持原生搜索 |
| `ACP_GROK_COMPAT` | 默认 `false`；为 Grok Responses 设置子进程 `features.multi_agent=false`，避免其不支持的 namespace 工具；保留普通函数、搜索、模型和显式推理强度等已有设置，检查伪装成成功文本的接口错误 |

Grok 兼容开关不代表服务端具备图像理解。切换前须分别验证完整图片、OCR、搜索及旧会话迁移；若接口接受图片却声称未收到，不能以 HTTP 200 或 OCR 成功宣称看图正常，也不得未经用户同意降级既有视觉能力。切换模型时可在 bot 的 `CODEX_CONFIG` 中明确设置 `model` 与 `model_reasoning_effort`，让恢复的旧会话采用目标模型；仍须用合成旧模型会话独立验证，不读取私人历史来做测试。

不同兼容提供方及模型的图片、搜索和参数支持可能不同，须分别用合成材料验证。不能因HTTP200就宣称识图成功，也不自动把视觉降为OCR-only。ACP的Grok兼容路径仅在工具后缺最终答案时请求一次续答；直连路径则校验完整最终答案，不自动补调用。

图片入口只接受经过签名验证的 PNG、JPEG、GIF 或 WebP。远程地址必须来自受信任的 QQ CDN，且每次跳转都会重新检查协议、端口、主机名和解析地址；消息里直接提供的本地路径、私网地址和超限内容不会交给 agent。没有 URL 的 OneBot 图片可以通过受控 `get_image` 解析；仅当解析后的真实路径位于 `ONEBOT_INBOUND_IMAGE_LOCAL_ROOTS` 内时才允许读取，并会再次检查常规文件、软链接逃逸和大小。macOS NapCat 应只配置具体缓存目录（例如 `.../NapCat/temp,.../NapCat/cache`），不要配置整个用户目录或磁盘根目录。

代理 Fake-IP（如 `198.18.0.0/15`）仍按保留地址阻止直连，不因 QQ CDN 域名而豁免。开启 `ONEBOT_INBOUND_IMAGE_STREAM` 后，下载器可使用经当前会话证明的图片 ID 调用 `download_file_image_stream`；只接受 `get_msg` 返回的真实图片数组段，不把文字中的 CQ 代码作为授权。流读取使用现有 OneBot WebSocket，不新增服务或开放目录；每块最多 64 KiB、默认总时限 10 秒，按配置限制实际累计字节，校验顺序及最终字节/块数，完整后才检查图片签名。NapCat 元数据可能是原图大小而实际流是缓存变体，因此实际总量独立受限，不要求二者相等；不支持流式接口或证明失败时明确失败，不回退到任意文件路径。

`ACP_LOCAL_VISION_OCR=true` 仅适用于 macOS。留空 command 时会通过 `/usr/bin/swift` 解释执行脚本；长期运行建议把脚本预编译，并让 `ACP_LOCAL_VISION_OCR_COMMAND` 指向该可执行文件。两种方式都调用系统 Vision 框架，图片字节走标准输入、不写临时图片文件；识别文本会明确标记为“不可信的图片数据”，不能当作系统指令或工具授权。此能力是对视觉模型的补充，不取代 ACP 的 `promptCapabilities.image`。

如果你需要可直接复制的 agent 配置示例，看 [ACP Agent 接入](agent-integration.md)。

### 文档、引用与联网搜索

- 文档支持 PDF 文字层、DOCX 正文/表格、XLSX 单元格/公式原文、TXT/MD/CSV/TSV/JSON/LOG。只处理当前消息和本次引用中的附件；旧版 DOC/XLS、加密 PDF、扫描页 OCR、嵌入图片和复杂版式暂不支持。每轮默认 2 件/共 20000 字符，超限与失败会明确提示给 agent。
- 文档下载使用 QQ CDN/私网/跳转/大小校验；缺 URL 或地址失效时通过 `get_private_file_url` 或 `get_group_file_url` 解析不透明文件 ID。NapCat 私聊 API 可能返回公网 IPv4/特定端口：只允许该本机 API 刚返回的精确 origin，不接受消息直接指定的 IP；跳转不可扩大允许范围，私网始终阻止。不调用可能无界下载的 `get_file`，不接受任意本地路径，也不扩大 NapCat 本地图片白名单。
- 文档字节通过标准输入交给独立 Python 进程，不创建附件临时文件；Office 压缩包限制展开大小/条目数/压缩比，不执行宏、公式或外部链接。解析进程有 CPU/墙钟超时、并发/输出限制；macOS 不宣称具备可靠的硬内存沙箱。扫描 PDF 会说明只有文字层可读。
- 所有发送者、群和 @ 校验先于 `get_msg` 与附件下载。引用只补全一层，不执行引用中的命令；跨群/跨私聊引用会被拒绝。机器人自己的旧私聊回复如缺 `target_id` 且当前进程未记录其消息 ID，无法证明收件人时会明确拒绝并请重发。
- `ACP_WEB_SEARCH=true`在ACP路径仅覆盖bot子进程的`CODEX_CONFIG.web_search`，不改桌面配置；在直连路径启用提供方hosted web_search。自然语言搜索或`/search 关键词`要求实际检索，但默认不主动附链接；当前问题明确索要来源时才显示，受全局来源规则控制。网页、引用、OCR、文档始终是不可信待分析数据，不能授予工具权限；搜索关键词最小化是提示约束，不是数据泄露硬隔离。
- 官方配置参考：[网页搜索模式](https://learn.chatgpt.com/docs/config-file/config-basic)、[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。第三方兼容接口必须独立验证，不能只看开关。

### 按人分析本群近期发言

开启 `ONEBOT_READ_GROUP_HISTORY=true` 后，在本群真实 @ 机器人，例如：

- `分析 @成员 最近20条发言`
- `总结 123456789 今天在本群说了什么`
- `读取张三的最近内容并分析`（群名片/昵称须完全且唯一匹配；重名会要求 @ 或 QQ 号）
- `看看 @成员 最近几条消息`（“几条/几句”解释为5条）
- `分析 @成员 刚刚发言的内容`（“刚刚/刚才”解释为近10分钟、默认最多10条）
- 引用该成员的一条本群消息后说 `分析刚刚发言的内容`（省略对象时从同群引用确定发言人；无引用不猜测对象）
- `/history @成员或QQ号 20 总结主要观点`，也支持 `今天`、`昨天`、`24h`、`7d` 范围。

默认分析最近7天内最近20条目标发言，每次1人，条数1–50；“近期/最近一些”采用默认范围。今天/昨天按北京时间自然日，滚动时间范围最长7天；不支持或超限输入明确报错，不悄悄改成另一范围。回复显示目标QQ号、采用范围、扫描数量和实际样本数；没有样本或对象不明时直接本地回复，不调用模型。已有的群主人/管理员/普通成员/特殊规则和按人限频继续生效，单次历史分析算一次请求。

检索仅调用当前群的 `get_group_msg_history`，每页50条，最多10页/500条群消息，总时限10秒，每页最多3秒。使用返回消息的 `message_id` 作为 NapCat 下一页 `message_seq` 参数（该接口会将短消息ID映射到原生ID），不会把QQ群序号当原生ID。验证会话/发送者/时间，去重并防分页循环；500条是群消息扫描上限，不保证其中有足够目标发言。失败、超时和不足保留已取得证据并明确说明，不能声称取得全量历史。同群同时只进行1项历史分析，整个进程最多2项。

历史只提取正文和提及标记，单条最多1000字符、提交模型的历史上下文总计不超过12000字符；图片、文件、音视频、合并转发及引用仅列占位，不自动下载或递归。模型只分析本次样本，注明时间和依据，不执行历史内容中的指令，不从旧会话补造证据。分析后统一回复，不逐条补发旧消息。

该按需分析功能不另建全量群聊数据库或后台监听缓存。选中样本会交给当前模型服务，并按所选后端的上下文规则留存；不能把“不新增数据库”理解为“不留存或不上传”。另行启用的@存档独立记录真实@事件。数据、构建及日志放库外运行目录，不进入Obsidian/iCloud。

### 关于 `ACP_AGENT_ARGS_JSON`

当前最常见的坑是：

- `ACP_AGENT_COMMAND=traex`
- 但 `ACP_AGENT_ARGS_JSON=[]`

这会让很多 `traex` / `traecli` 安装启动交互式界面，而不是 `acp serve`，随后表现成 `ACP connection closed`。

对 `traex` / `traecli`，推荐明确写成：

```env
ACP_AGENT_COMMAND=traex
ACP_AGENT_ARGS_JSON=["acp","serve"]
```

当前代码在参数留空时也会对 `traex` / `traecli` 自动补成这个默认值，但文档层面仍然建议显式写出来。

## Session Store

现在支持三种 session store：

- `SESSION_STORE=file`：默认值，适合单机 / 单容器路径
- `SESSION_STORE=redis`：适合多实例、长运行容器和外部存储
- `SESSION_STORE=postgres`：适合已有 Postgres、希望更偏持久化 / 查询友好的部署

### File store

默认行为，不需要额外依赖：

```env
SESSION_STORE=file
SESSION_FILE_PATH=./data/sessions.json
SESSION_TTL_MINUTES=120
```

### Redis store

最小配置：

```env
SESSION_STORE=redis
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_KEY_PREFIX=qq-ai-bot
SESSION_TTL_MINUTES=120
```

说明：

- bot 会为每个 QQ 会话写一个 Redis key
- 同时维护一个 session key 集合，方便列出当前持久化会话
- TTL 与 `SESSION_TTL_MINUTES` 对齐
- `REDIS_KEY_PREFIX` 用来隔离不同环境，例如 `qq-ai-bot-prod` / `qq-ai-bot-dev`

如果你已经准备做多实例部署，Redis store 会比本地 JSON 文件更像生产形态。

### Postgres store

最小配置：

```env
SESSION_STORE=postgres
POSTGRES_URL=postgres://user:password@127.0.0.1:5432/qq_ai_bot
POSTGRES_TABLE=qq_ai_bot_sessions
SESSION_TTL_MINUTES=120
```

说明：

- bot 会自动创建一张简单 session 表和 `expires_at` 索引
- `POSTGRES_TABLE` 只允许简单 SQL identifier，避免把任意 SQL 拼进表名
- 每条记录包含 `conversation_key`、`payload_json`、`updated_at`、`expires_at`
- `clearExpired` 会删除过期记录并返回被删除的 conversation key
- 如果你已经有可靠的 Postgres 备份 / 监控，Postgres store 会比本地 JSON 文件更适合长期持久化
- 如果你只想最短路径跑多实例，Redis store 仍然更轻；如果你想要后续审计 / 查询能力，Postgres store 更合适

## 分群配置文件

`ONEBOT_GROUP_CONFIG_FILE` 指向一个 JSON 文件。建议把仓库里的示例文件复制一份本地再改：

```bash
cp examples/group-rules.example.json examples/group-rules.local.json
```

示例：

```json
{
  "defaultSystemPrompt": "你是一个稳定、可靠、实事求是的 QQ AI 助手。",
  "groups": {
    "123456789": {
      "name": "技术讨论群",
      "enabled": true,
      "requireMention": true,
      "systemPrompt": "你正在服务技术讨论群。优先给出结论、原因、风险和下一步建议。"
    },
    "223344556": {
      "name": "运营值班群",
      "enabled": true,
      "requireMention": false,
      "systemPrompt": "你正在服务运营值班群。回答尽量短，优先给可执行处理建议。"
    },
    "987654321": {
      "name": "静默通知群",
      "enabled": false
    }
  }
}
```

支持的字段：

- `defaultSystemPrompt`：全局默认 prompt
- `groups.<groupId>.name`：展示名称，方便排查
- `groups.<groupId>.enabled`：是否启用该群
- `groups.<groupId>.requireMention`：该群是否必须 `@` 才答复
- `groups.<groupId>.systemPrompt`：该群专属 prompt

## Prompt 优先级

```text
group.systemPrompt > ACP_DEFAULT_SYSTEM_PROMPT > 无
```

如果分群配置文件里设置了 `defaultSystemPrompt`，而 `.env` 里也设置了 `ACP_DEFAULT_SYSTEM_PROMPT`，以 `.env` 为准。

## 命令

### 群内分级与逐人限频

可在指定群的规则中启用以下字段，私聊白名单和其他群不受影响：

```json
{
  "allowAllMembers": true,
  "requireMention": true,
  "replyLimits": { "admin": 5, "member": 3 },
  "memberRules": {
    "123456789": { "label": "测试员", "limitPerMinute": 3 },
    "223344556": { "label": "特别许可", "limitPerMinute": 0 },
    "323344556": { "blocked": true }
  }
}
```

- 判定顺序：群/用户黑名单及真实@校验 → 本人不限频 → 特殊单人规则 → QQ群主/管理员 → 普通群友。上例显式设置管理5次、普通成员3次/分钟；未设置replyLimits的开放群沿用代码兼容默认管理5次、普通1次。`allowAllMembers`仅绕过该群用户白名单，不放开私聊/其他群；QQ群主身份不等于机器人主人。
- 按每人每群滚动60秒预约请求额度，命令/搜索/问答共享额度；模型答复拆分成多条QQ消息仍算一次。并发请求原子预约；已接受但后续失败的请求也计一次，拒绝请求不会延长冷却。
- 超限或被特殊暂停的用户静默忽略，不发送额外限频提示、不调用模型、不读取引用/附件。管理员身份只相信匹配群号/QQ号的 `get_group_member_info` 结果，缓存30秒，失败按普通成员限额处理；不信任消息正文自称管理员。默认单实例内存计数，服务重启会清空最多60秒的计数。
- 特殊规则优先于群主/管理员/普通成员，不能覆盖本人；`limitPerMinute=0` 表示不限频，`blocked=true` 暂停回复，仅有label时仍按QQ原身份额度。群管理设置不随普通聊天开放：`/reset`、`/prompt`、`/quiet`、`/progress`、`/verbose` 和 `/member` 在开放群只允许机器人本人操作；其他人 `/status` 只看公开状态和自身分级，不显示内部会话标识。
- 本人在目标群@机器人使用：`/member list`，`/member QQ号 limit 3`，`/member QQ号 unlimited`，`/member QQ号 block`，`/member QQ号 label 标签`，`/member QQ号 clear`。clear恢复该用户QQ身份默认限额，不清空本分钟已预约记录。
- 特殊规则命令保存到现有分群JSON（原子写入，保留其他字段和mode0600旧副本），更新内存后立即生效并可跨重启保留。修改限额不清空现有有限额度记录。默认不标记任何具体成员，不做原生QQ群禁言或踢人。

默认命令前缀是 `/`。

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看帮助 |
| `/status` | 查看当前会话、触发策略、prompt 来源 |
| `/prompt` | 查看当前生效的 system prompt |
| `/reset` | 清空当前会话并重建 |
| `/ping` | 存活检查 |
| `/search 关键词` | 联网搜索，需开启`ACP_WEB_SEARCH`；链接展示服从全局来源规则，群聊仍须@ |
| `/member` | 特殊成员规则帮助，限本人在目标群使用 |
另外：

- HTTP `/status`（受管理鉴权保护）返回`build`字段。
- HTTP `/status`返回`sessionStore`。
- HTTP `/status`返回入站去重配置和缓存大小；`/healthz`仅返回进程存活布尔值，`/readyz`仅返回QQ连接就绪布尔值，未连接时HTTP503。
- QQ 内的 `/status` 也会显示当前版本与启动时间
- HTTP `/metrics` 会返回 Prometheus 风格文本指标，当前包含 OneBot 连接状态、重连次数、入站 / 重复入站 / 出站消息计数、ACP prompt 调用 / 失败计数、活跃 / 持久化会话数，以及 `qq_ai_bot_turn_duration_seconds`、`qq_ai_bot_agent_roundtrip_seconds`、`qq_ai_bot_reply_send_seconds` 三类低基数 latency histogram

如果你在 Docker / CI / 发布流程里注入了 `APP_GIT_COMMIT` 或 `APP_BUILD_REF`，它们也会一起显示出来，便于排查线上实例到底跑的是哪个版本。

## 进度播报是怎么工作的

这部分不是靠前端“假装在思考”，而是把 agent 的增量状态真的接了出来。

流程大致是：

1. `ACPAgentBridge` 向本地 agent 发送 prompt
2. agent 在处理中持续回传 `plan`、`tool_call`、`tool_call_update`、`agent_message_chunk` 等增量事件
3. bot 在本地聚合这些事件
4. `ProgressReporter` 按节流配置整理成可读文本，再发回 QQ
5. 最终结果出来后，再单独发送正式答复

跟进度播报直接相关的配置：

- `ONEBOT_PROGRESS_MODE`
- `ACP_PROGRESS_THROTTLE_MS`
- `ACP_MAX_PROGRESS_UPDATES`

## correlation ID / 单轮链路追踪

现在每一条被接受处理的入站消息都会派生一个 `correlationId`，并尽量贯穿到：

- receive / 接收日志
- dedupe / 去重判定日志
- ACP prompt dispatch 日志
- progress / 进度播报日志
- final reply / 最终回复日志

适合的使用方式：

- 当某一轮消息“看起来重复了 / 卡住了 / 回复慢了”时，先按 `correlationId` 聚合同一轮日志
- 如果你在看 JSON 日志，直接筛 `correlationId`
- 如果你在看终端 pretty logs，也可以搜索同一个 `correlationId` 字符串

说明：

- 有可靠 `message_id` 时，`correlationId` 会尽量稳定地带上会话和消息标识
- 没有可靠 `message_id` 时，会退回到去重指纹的短哈希
- 这不是分布式 trace 标准实现，但足够把单轮 QQ → OneBot → ACP → reply 的日志串起来

## 轻量入站去重

为了降低 OneBot 重连、重复上报或边界情况下的重复 prompt 触发，bot 现在会在进入命令处理 / ACP dispatch 之前做一层**轻量入站去重**。

默认配置：

```env
ONEBOT_INBOUND_DEDUPE_WINDOW_MS=120000
ONEBOT_INBOUND_DEDUPE_MAX_ENTRIES=2048
```

行为说明：

- 优先使用 `message_id` + 会话维度做去重
- 如果事件没有可靠的 `message_id`，会退回到会话、发送者、时间桶、文本摘要等组合键
- 这是 **best-effort replay guard**，不是严格的 exactly-once 保证
- 当前只做单实例内存级缓存，不做跨实例协调

适合场景：

- 避免短时间内重复触发同一条 `/status`、`/reset` 等命令
- 避免 OneBot 重放导致同一条用户消息再次打到 ACP agent
- 降低进度播报和最终回复的重复噪声

## 本地 @ 提问与回复记录

`BOT_MENTION_JOURNAL_FILE`默认为空（关闭）。指定库外本地绝对路径后启用独立JSONL记录，例如本机运行的`logs/mentions/events.jsonl`。不写入Obsidian/iCloud/CloudStorage，不轮转、不按时间/数量删除，不受`/reset`、会话清理或模型上下文100条/24小时策略影响；不会为启用功能回填旧聊天。

仅记录允许群内真实@机器人且非机器人自身的消息，不记录普通群聊、纯文字伪造@、@全体或私聊。记录发生在个人权限/限频之前，因此所有人的真实@都会保留；同进程重复上报按原去重规则跳过。群范围仍服从原群白名单/禁用规则，不扩展账号权限。

每行包含`version`、UTC时间、北京时间、`correlationId`、群号、提问消息ID、发言人QQ及当时名片/昵称。`question`保存原消息文字而非截短的模型输入，群名可用时保存，附件只记类型/文件名/大小及引用消息ID；不额外下载/保存媒体或引用全文。`reply`按实际发送片段保存文字、语音合成文字、回复消息ID及purpose，并区分`acknowledged`（OneBot确认，不等于手机可见）、`rejected`、`unconfirmed`、`failed`；不保存音频/图片base64或接口返回错误原文。`processing_result`标记完成、处理失败、个人策略拦截、限频或队列取消。同一提问可对应多个回复片段，按`correlationId`关联。

默认`recallStatus=not-verified`：这是“曾收到的提问记录”，不会因之后撤回自动删除，也不宣称当前群内仍可见。暂未增加撤回状态识别。记录不回灌模型、不接入普通历史分析命令，不增加模型调用；未来如需让机器人查询此文件，应另做权限设计。

目录创建权限0700、文件0600；追加写入拒绝文件软链接并核验目录不落云盘。磁盘/权限异常不阻止原回复，在`/status.mentionJournal`显示健康状态、失败数及安全错误码（计数从本次启动起算，不展示正文）。停机等待写入完成；没有自动存储上限，须自行留意设备空间。
