# 部署形态

## 推荐：独立API后端

QQ/NapCat → 已认证OneBot WebSocket → AiteEcho权限/输入预算 → 兼容Responses的API → 完整答案 → QQ发送回执。

AI_BACKEND=direct不启动Codex进程，也不依赖桌面会话。API地址、模型和密钥必须自行填写，不预设某个中转站或个人模型。群聊与私聊默认关闭，按自己的名单明确启用。

模型只获得受限的当前材料与可选短历史，不拥有本机命令工具。文档、引用、OCR及图片由有界本地模块提供；hosted搜索须接口支持。通用设置见[自定义入口](customization.md)。

## 可选：ACP兼容后端

QQ/NapCat → OneBot → AiteEcho → 操作者选择的ACP agent → 其模型/工具。

mock agent可验证接线，不是真实推理；traex、自定义agent等须分别配置并验证。ACP可能具备更多本机工具权限，不能把直连后端的无命令能力安全边界套在它上面；不要仅因为协议接通就允许群友无限执行工具。

## 单实例与外部存储

默认file store适合单机。Redis/Postgres可替换会话存储，但并不自动提供跨实例去重、分钟限额、语音预算或分布式锁。当前队列、限频与连接状态仍有进程内部分；多个实例监听同一QQ事件可能重复调用和回复，不能只切数据库就宣称高可用。

迁移前读[多实例限制](multi-instance-notes.md)，先隔离不同账号/群或安排单一活跃消费者，独立验证故障与重启。

## Docker

只提供自行构建的Dockerfile/Compose与手动烟测工作流，不依赖维护者预发布镜像。跨容器监听须独立强token，宿主端口只发布到回环地址，运行数据放独立私有目录。容器健康、QQ登录、模型生成和真实客户端效果分别验收。

相关说明：[Docker](docker-quickstart.md)、[验证边界](deployment-validation.md)、[安全](../SECURITY.md)。
