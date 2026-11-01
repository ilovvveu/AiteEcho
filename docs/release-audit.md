# 本地整理与验收记录

2026-11-01：本轮仅优化源码及准备独立源码副本，未发布GitHub、未部署或重启现有机器人，不代表所有平台/真实客户端已验收。

## 已完成的整改

- 项目品牌/维护入口改为AiteEcho / ilovvveu；移除旧推广、捐款与付款图片，原MIT版权及来源保留在LICENSE/NOTICE。不宣称原始代码由新维护者独立创作。
- 后续按维护者要求在README页首单独展示Reverix AI广告／代理入口，与软件配置分离，不绑定API。仅纳入经检查的单张品牌横幅，以精确路径、PNG签名、大小和SHA-256限制发布；不分发原品牌压缩包，也未核实或承诺服务方价格、模型与可用性。
- 不带个人账号/群号/API端点/密钥/聊天、角色选择或音色。全局角色与default为空白，分群示例为空，群聊/私聊默认关闭，直连模型及启用语音的voiceId须自行填写。
- API、强度、预算、留存、风格、链接、语音门槛/各级额度均有[配置入口](customization.md)。安全边界不由人设授予。
- 管理及反向WS默认回环监听，外部监听强制独立强token；状态/指标受保护，公开健康/就绪不暴露配置。
- 容纳异常OneBot事件，限制WS载荷，修复真实@后紧邻文字被误删；保留既有超时、回执与提交后防重放保护。
- macOS工具不再用宽泛pkill停止bot、不强制覆盖聊天设置，状态隐藏token，配置原子0600写入、拒绝软链接，导入工具模块不自动执行命令。
- 生产构建排除测试/fixture/test-support；npm包内容与独立源码导出均按清单审核。Docker不再COPY整个工作目录，排除私有配置/数据/缓存，非root运行。
- CI增加构建、虚拟OneBot/API烟测、发布扫描和依赖审计；Docker工作流只手动构建/测试，不自动推镜像。

## 已验证

- macOS ARM64 / Node24：lint、typecheck、测试、生产构建及编译产物烟测通过；测试计数以最近一次执行结果为准。
- 虚拟OneBot/API烟测只连本地回环，不启动Codex、不调用真实模型/TTS、不发送QQ消息。
- npm全量及生产依赖审计为0条已知漏洞（截至本次查询）。开发依赖minimatch通过override升至11.0.1以上，避免已公告的glob模式放大问题，保留ESLint/TypeScript工具主版本并回归；不代表永久无新漏洞，也不覆盖Python/系统依赖。
- 发布扫描包含文件清单、密钥模式、已知私有部署值、Markdown文件链接和npm实际待打包内容。仅源码中的localhost合成TLS测试夹具允许测试私钥；生产包与生产dist不包含它。

漏洞依据：[minimatch公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)。后续依赖升级后可移除不再必要的override，但须重新审计/回归。

## 未完成或明确不包含

- 本机没有Docker引擎，当前只做Dockerfile/上下文/脚本静态检查；实际AMD64/ARM64镜像构建、镜像层/缓存审计及容器运行仍待具备环境后验证。
- Node22/Linux远端CI、Windows、真实QQ登录/图片/语音客户端效果未由本轮测试证明。
- 源码工作区保留原Git历史与用户未提交改动，不原地清洗历史。独立候选副本不带.git、env、data、日志或QQ/NapCat程序；以后上传需对最终内容/账号另作确认，不能直接推现有origin。
- 公网可达性、第三方模型/搜索/声音权限及账单不由本地测试保证，模型故障或系统断网也不会因这次整理消失。

复验命令：npm ci、npm run check、npm run build、npm run smoke:build、npm run audit:release、npm audit。文档测试先安装scripts/requirements-test.txt，或通过QQ_DOCUMENT_TEST_PYTHON选择专用解释器；缺依赖会明确跳过，不能当全覆盖。
