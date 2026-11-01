# AiteEcho 架构

QQ ↔ NapCat/OneBot ↔ AiteEcho ↔ Responses兼容API（或可选ACP agent）。NapCat是独立项目，不是本仓库反编译出的组件。

- src/channels/onebot：规范化、真实@、会话来源、反向/正向WS、回执与QQ媒体发送。
- src/core：权限/限频、队列、引用与有界群历史、文档/OCR、短期上下文、风格/规则、语音门控及私有存储。
- src/agents/direct：无桌面Codex依赖的独立HTTPS请求、预算与截止、提交前回退/提交后防重放、完整响应校验。
- src/agents/acp：可选agent兼容；direct仍复用其共享提示结构，不能未经依赖检查整目录删除。
- src/infra：配置载入、诊断元数据、日志；管理接口默认回环，非回环须鉴权。

短期上下文与@存档分离：前者可有界进入请求，后者追加保存、不自动清理或上传模型。QQ读取、模型请求与QQ发送均独立记录，不把某一层成功当作全链路成功。

源码、发行副本和真实运行副本应隔离；.env/config/data/日志仅在本机运行区。许可证/来源见NOTICE，不附QQ/NapCat程序或账号。
