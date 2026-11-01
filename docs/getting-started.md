# 快速开始

主路径是 QQ ↔ NapCat/OneBot ↔ AiteEcho ↔ Responses兼容API。源码不包含QQ/NapCat二进制，不需要桌面Codex运行；可选ACP另见 agent-integration.md。

1. 取得源码后，按README执行npm ci，复制.env.example和群规则示例；不把待发布仓库元数据视为已经可用的下载地址。
2. 填自己的API地址/模型/密钥；地址应是 /v1 等API前缀，程序拼接 /responses。不要填聊天网页或把密钥写进地址。
3. 设置主人QQ及允许的群/用户，才开启 ONEBOT_ALLOW_PRIVATE / ONEBOT_ALLOW_GROUP。示例默认关闭聊天，群默认必须真实@。
4. 用 node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" 生成随机OneBot token，填入机器人和NapCat两侧。不要使用change-me或同一份管理口密钥。
5. NapCat选择反向WS、消息格式array，连接本机 ws://127.0.0.1:16700/onebot/v11/ws；token须一致。跨容器主机名见Docker说明，不能照抄本机回环地址。
6. npm run build && npm start。先看 /healthz，再看仅返回就绪布尔值的 /readyz，必要时在本机查看 /status；配置BOT_ADMIN_TOKEN时加Authorization: Bearer请求头。
7. 用允许的QQ账号主动发一条新提问验收；不要重放全部旧历史。

.env.local覆盖.env；启动环境中已存在的值优先于文件。依赖与构建放本机工程目录，密钥/会话/日志放私有运行区并排除Git，不放笔记云盘。功能/依赖和隐私边界见README及configuration.md。
