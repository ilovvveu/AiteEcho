# 独立API后端与故障定位

`AI_BACKEND=direct` 使用Node HTTPS直接请求现有提供方的`/responses`，不启动codex-acp、Codex CLI或桌面应用，不需要Codex登录/桌面认证/官方额度。`DIRECT_API_BASE_URL`填同一提供方的`/v1`根地址，`DIRECT_API_KEY_ENV`默认从`QQ_CODEX_API_KEY`读取；日志和状态不输出密钥/接口地址。模型与强度由`DIRECT_API_MODEL`/`DIRECT_API_REASONING`指定，实际生效值以运行配置和`/status`为准。

默认非流式（`stream=false`），QQ等待完整结果后发送；`store=false`，不使用previous_response_id/远端会话，不请求或回传reasoning密文。只保存成功发送的文字问答。不执行模型生成的function调用或本机命令；QQ文件摘录、引用、Vision OCR与图片由现有受限本机模块处理，联网搜索仅用提供方支持的hosted web_search。

## 全局表达与来源显示

`BOT_REPLY_RULES_FILE`指向独立的`config/reply-rules.json`，与按会话选择的风格分开。默认`sourceLinks=on_request`：可以联网核实但不主动附来源列表/网址；只有当前问题明确索要来源、链接、官网或下载地址时保留。直连层和QQ发送前双层处理正文与来源注释；不会删除代码中的网址或用户本条已经给出的网址，也不关闭搜索。其他设置和热加载边界见[全局回复规则](configuration.md#全局回复规则)。

全局提示明确历史仅作事实/人物/话题衔接，旧助手的语气不是当前文风示例，当前选定风格优先；并未清空历史或额外调用模型摘要。邻家姐姐预设补充轻松接梗、避免短句训诫及温暖而不越界的示好回应。它仍是模型表达指导，不是每句必然服从的硬保证；程序硬控制的是链接展示。

## 上下文预算

### 全场景风格与最终答案

full-scene-v3将选定风格用于澄清、事实播报、解释、拒绝及失败提示，不改变原安全/权限边界。明确缺城市的简单天气问题可按当前预设本地追问，0模型调用；43个内置风格有受控表达。仅在无引用/附件且所选上下文未提供当前发言人的地点时使用；复杂问题、天气感叹、有地点或引用的问答仍交模型，不默认读取系统定位或把其他群友的地点套用过来。失败提示保留诊断编号，鉴权/限流/无完整答案分别说明，不一律要求reset。

在历史开启时，同一发言人10分钟内回答待补城市追问（如只回“北京”），会在原最新6轮候选内衔接天气，不从更早记录检索；更换自己的话题、明确取消/问其他问题、不属于同一人或历史关闭时不自动套用。短地名为启发式识别，不是完整地点词典；复杂地名或超出窗口可明确说“查询某地天气”或引用原消息。

直连解析优先选择完成的final_answer消息；没有显式final_answer时兼容完成的无phase消息。commentary/analysis/未知phase及未完成消息不当答案；只有过程消息则报NO_FINAL_ANSWER，不自动补调用。对于把过程句并入无phase正文的兼容服务，仅清理开头独立的“我去查一下”等短过程行，保留事实段落/代码；过程句埋在正文中的任意位置仍可能需要提供方配合，不能保证所有措辞都可机械识别。

直连历史先取原上限内的最新6轮候选，再按话题关联/同一发言人的继续追问筛选；天气只自动携带当前发言人的近期天气内容，跨成员地点需要本轮明确引用，不向更早记录扩大检索。风格ID/内容版本不同或旧记录无版本时，相关旧答案作为标记的参考节选（最多600字符）发送；完整原文仍在本地保留，并未摘要或删除。历史可能少于6轮甚至0轮；遇到被省略的长答案细节可明确引用。原ACP路径保留既有历史选择行为。

新完成问答在本地增加senderId、styleId、styleVersion、rulesVersion、scene/topic元数据，原100轮/24小时/120000字符保留规则不变。JSONL的reply_profile记当轮选择、12位内容hash、场景、历史候选/选中轮数及来源开关；input_budget记最终预算后的historyTurns/historyChars，response_select记排除的commentary数量与实际最终消息数，不记录风格全文或聊天正文。/status.config.replyPipeline可核对生效版本。角色风格仍由模型生成，功能测试通过不等于任意场景语气获得用户验收。

源码及示例默认`DIRECT_API_SEND_HISTORY=false`；各部署可显式开启，当前值以受保护状态接口为准。明确引用、附件摘录、风格及本轮主动要求的群发言分析属于当前材料，不受历史开关禁用。本地保留有限问答不等于全部上传；关闭后无法自动理解“接着刚才”，请直接引用相关消息。

仅机器人主人可用`/context`或`/context status`查看，`/context on`为当前群/私聊开启近期问答，`/context off`关闭，`/context default`恢复全局默认。群内仍须真实@；命令不调用模型。选择按会话持久化，重启保留；`/reset`清除会话后回到全局默认。该开关不改变风格选择或本地记录保留。

必须启用`CONTEXT_BOUNDED=true`。本机保留最多100次/24小时/120000字符；历史携带开启时，每次最多发送6次/3000字符。关闭时发送0条旧问答，不为清理调用摘要模型。

直连层将系统/风格、当前提问、引用/文档/OCR/群历史分析材料和近期问答的**全部输入文字合计**限制为10000字符、UTF-8不超过20000字节，先达到者限制。当前问题优先，历史从最旧完整问答丢弃，长材料标注截断。当前问题最多6000字符、额外系统/风格最多2500字符。

这不是总token或账单上限：图片、工具定义及提供方自加提示仍额外计费；输出请求上限4096 tokens，提供方需自行遵守。超预算时只分析实际取得的节选，不假装读完。原ACP后端仍保留独立兼容路径及其旧配置说明，直连模式不再创建/恢复Codex会话。

搜索指定`search_context_size=low`，默认请求`max_tool_calls=1`。仅在已确认提供方不支持该参数时，才配置`DIRECT_API_MAX_TOOL_CALLS_SUPPORTED=false`；省略此字段不禁用搜索，不改变模型、强度或输入输出预算。`/status.config.directApi`显示兼容开关及有发送时的requestedMaxToolCalls。不能推断所有GPT/Grok兼容接口支持相同参数。

省略字段后没有服务端工具次数请求上限；即使发送了，第三方兼容服务是否执行也须观察。继续标记SEARCH_CALL_ITEMS_OVER_LIMIT，但它是响应后的诊断，不是计费硬上限。服务内部搜索材料可能增加其报告输入token，不能算作机器人重复传历史。诊断同时记录本机输入字符/字节与接口报告用量；明显超出本机文字预算时标记UPSTREAM_EXPANDED_CONTEXT，便于向提供方核对。

完整HTTP400响应只解析固定白名单中的不支持参数，记录upstream_request_validation/UNSUPPORTED_MAX_TOOL_CALLS等固定代码；不记录提供方原文、未知参数、正文、URL或密钥，不自动改配置或重发已提交请求。鉴权、其他400/5xx与原重试边界不变。

第三方服务可能忽略工具次数限制或报告包含内部搜索的更大用量，不能把请求参数当严格账单保证。请对照本机发送字符数、接口报告tokens及SEARCH_CALL_ITEMS_OVER_LIMIT等诊断与提供方核实。

## 时限与重试

### 连接关闭兼容与响应完整性

部分兼容网络链路在`Connection: close`模式下可能出现HTTP200后正文截断。此适配显式请求keep-alive并验证响应完整性；不能仅据此断定VPN或提供方内部根因。

直连请求保持`agent:false`一次一连接，但显式发送`Connection: keep-alive`，避免让远端提前采用close模式。显式启用本机代理回退时，每次尝试使用独立CONNECT agent；完整接收（或超时/失败）后释放请求、agent及仍在建立的代理连接，不建立跨用户/跨轮复用的连接池。不读取系统代理环境、不改VPN、API地址/模型/强度、stream=false或任何上下文预算。

HTTP200不等于回答成功。只有响应正常结束、Node的`response.complete=true`且声明`Content-Length`时实际字节数完全一致，才进入原JSON/模型状态/最终答案校验；chunked以HTTP解析器完整结束为准。不从截断体提取“看似完整”的JSON/部分答案，也不把它写入成功上下文。中断、长度不符或协议失败不自动重试，避免已处理请求的重复计费。

`http_headers`与新增`response_integrity`记录`requestConnection`、归一化后的`responseConnection`、`responseFraming`、`expectedBytes`（若声明）、实际`bytes`、`responseComplete`、`responseBodyStarted`、HTTP状态/请求编号和安全错误码。Connection/传输方式只写固定枚举，不记录原始响应头、正文、密钥或URL；可区分“只收到200头”“收了一部分后断开”“完整收取但JSON/模型答案不合规”。

- `DIRECT_API_CONNECT_TIMEOUT_MS=10000`：DNS/连接/TLS建立阶段合计截止。
- `DIRECT_API_FIRST_BYTE_TIMEOUT_MS=90000`：从实际提交HTTP请求开始计时，即使已返回空HTTP头也生效；首个正文数据到来后，响应体无数据30秒中止。非流式/high可能生成完才返回正文，因此默认由60秒放宽到90秒，不降低high或改流式；既有显式60000配置仍优先，须在部署时单独调整。仍受120秒总截止约束，不代表能修复提供方内部挂起或网络中断。TLS握手等待由连接截止处理，不误算成已发出的请求。
- `DIRECT_API_TOTAL_TIMEOUT_MS=120000`：**整个API阶段所有尝试合计**硬上限，包含最多一次重试。仅提交前瞬时连接错误、明确429/5xx可再试；已提交POST后无响应、连接断开、鉴权/协议/内容错误或断裂响应不自动重发。不跟随重定向，不叠加SDK/agent隐藏重试。
- QQ读取动作原默认10秒或各自更短截止保持；消息发送单次等待回执30秒，避免与NapCat内部约10秒发送截止竞争。只有无失败状态/非零retcode且取得有效message_id才记为发送成功，文字/图片与语音一致。拒绝、无ID、超时、断线分别记录ONEBOT_SEND_REJECTED、ONEBOT_SEND_UNCONFIRMED、ONEBOT_ACTION_TIMEOUT、ONEBOT_CONNECTION_CLOSED，不再混为UNEXPECTED或成功上下文。ACK不等于客户端可见/可播放；最终文字/图片未确认发送不自动重发，也不再额外发送“失败”通知，以免原答案已到达却收到矛盾提示。其他明确错误仍沿用一次错误提示；既有群语音失败转文字规则保持，本轮不更改语音策略。
- 反向WebSocket新连接替换旧连接时，旧动作按断线结束、不重放，旧连接后续关闭/数据/错误不能覆盖新连接状态；新请求可正常使用新连接。待处理最多8项，真正开始处理时已等候超过60秒则取消并提示重发，不无限补发积压旧回答。

附件/OCR仍按各自时限执行，API的120秒不包含排队或这些阶段。提交后的超时不代表上游未处理，客户端无法确认或取消提供方内部生成，因此不重放该POST；已提交前连接失败与明确429/5xx仍共用最多两次尝试。不能保证提供方不对失败请求计费，也不对不完整回答自动补答。

## VPN边界

默认仍为Node直连，不读取HTTP_PROXY/HTTPS_PROXY或macOS系统代理，不依附桌面Codex会话。可经明确授权设置`DIRECT_API_LOCAL_PROXY_URL=http://127.0.0.1:端口`，也接受显式`[::1]`；只允许数字回环地址的HTTP代理，必须指定端口，不接受远程地址、认证信息、路径、查询或片段。空值关闭，不自动扫描本机代理。

启用后优先直连。HTTP头与正文仅在TCP建立（HTTPS还须TLS握手成功）后才显式提交；DNS/TCP/CONNECT连接错误，以及**明确未提交请求且TLS尚未建立**时的瞬时握手重置/超时，可在原最多一次重试及120秒总截止内改走既有本机HTTP CONNECT代理。缺少发送状态证明的TLS错误不换路；证书、协议与代理407错误不绕过，也不降低TLS验证或修改SNI。每会话的代理偏好仍为60秒，过期再试直连；优先代理若在提交前连接失败，可在同一预算内退直连。

若直连POST已提交后发生首字节超时或无响应断连，当前请求直接结束、不立即换路重放；只为**下一条由用户独立触发的新请求**设置60秒既有代理偏好，并记录`route_preference`。这不是后台补发、重问模型或额外尝试。HTTP明确429/5xx保留原同路有界重试；响应正文中断、协议失败和401/403仍不重试，也不以候选部分答案假装成功。

日志保留固定枚举`route=direct|local_proxy`、`proxy_connect`及`route_fallback`，`request_submit`、`request_state`的`requestSubmitted`/`tlsEstablished`布尔值以及只影响后续新请求的`route_preference`，不输出代理URL、CONNECT头、认证或正文。`request_write`在Node本地writable完成时记录requestFlushed=true及请求字节数，request_state保留该状态，api_complete错误带failureStage/HTTP状态及已有提交状态，便于区分上传未完成与等待响应。`requestSubmitted=true`仅表示开始提交，requestFlushed也只是本地发送层完成，二者都不是服务端收齐/处理/计费证明；false和TLS尚未建立共同约束握手回退。状态显示策略、60秒窗口与`submittedRequestTimeoutRetry=false`；`transport=node-direct-https`表示独立Node后端，不表示所有尝试都直连。代理仅用于原Responses链路，QQ附件与语音合成路径未改。

CONNECT建立期的取消也会立即关闭尚未交给HTTP请求的底层连接。TLS socket有局部的收尾错误监听，防止请求监听器解除后底层abort转发成未处理异常；请求仍在进行时的网络/TLS错误照常拒绝，不使用全局异常吞掉器，也不将失败变成成功。独立本地TLS子进程验证正常完整回答与截断响应的收尾。

仍使用系统DNS与操作系统网络栈；系统级TUN/Fake-IP、断网、睡眠、QQ或提供方不可达仍可能阻断。不会自动关闭VPN、改代理节点/DNS或切换提供方。若本机代理/VPN完全不可用且提供方直连也不可达，仍不能生成在线答案；此时有界退出并留下分环节记录。Codex退出不影响独立bot，但不等于机器人能绕过网络中断。

## 诊断日志

`BOT_DIAGNOSTIC_LOG`设为库外文件，如运行区`logs/bot-diagnostics.jsonl`。每文件默认5MiB，保留当前及`.1`–`.3`共4份，0600。记录诊断编号、阶段、耗时、HTTP状态、上游request-id、安全错误码、输入/用量统计；不记录正文、图片、密钥、完整请求/响应、URL或认证头。日志写入故障/丢弃计数也在状态显示。旧stdout日志不追溯改写；新接收/发送日志已移除正文preview。

| 阶段 | 能判断的边界 |
| --- | --- |
| service_start / service_shutdown / qq_link | 服务启停及QQ连接建立/断开，区分消息未进入与API失败 |
| qq_receive / queue | QQ事件已接收、等待还是队列过期 |
| quote_resolve / document_read / image_resolve / ocr | 引用或附件读取/解析失败 |
| dns / tcp_connect / tls | DNS、TCP、TLS阶段及安全错误码；DNS是否返回Fake-IP |
| proxy_connect / route_fallback / route_preference | CONNECT是否成功、本次提交前改路还是仅下条新请求偏好；不保存代理地址/头 |
| request_submit / request_write / request_state | TLS、开始提交及本地写入完成状态；区分握手/上传/等待响应，不能替代提供方接收/处理/计费日志 |
| http_headers / first_byte / api_body | 有无HTTP响应、状态码、等待首字节或读体中断 |
| response_integrity | 声明长度/实际字节、HTTP正文是否完整、正文是否开始、连接/分帧固定枚举；区分传输截断与内容校验 |
| response_validate / api_complete | 协议/模型答案是否有效、用量、API整体结果 |
| qq_send / qq_error_send / qq_notice / context_store / context_cleanup | QQ发送还是本机记忆持久化出错；DELIVERY_UNCERTAIN_NO_RESEND表示未确认发送后没有自动重发/追加失败通知 |

`/status.onebot.connected`只证明QQ连接；`ai.backend`、`ai.state`、最近成功及失败记录单独展示。启动时AI状态unknown，不会将QQ在线当推理健康。错误回复含诊断编号，在JSONL中查相同correlationId；旧索引中精确匹配的传输错误回复会在启动/发送前/定时修剪时移除，正常讨论网络问题的答案不受影响。

这些日志能定位本机失败阶段及网关HTTP结果，不能取代提供方内部日志解释其上游故障。切换前备份会话索引，旧记录可从库外恢复点找回。
