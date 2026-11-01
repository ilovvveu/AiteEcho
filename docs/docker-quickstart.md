# Docker 自行构建

本修改版不默认拉取上游或尚未发布的自有GHCR镜像。

1. 复制 .env.docker.example 为 .env.docker，填入API地址/模型/密钥、主人及允许范围。两种聊天示例默认关闭。
2. 为BOT_ADMIN_TOKEN、ONEBOT_ACCESS_TOKEN、NapCat WebUI分别生成不同的24字符以上随机token。将OneBot同一token写入NapCat配置和机器人；示例NapCat文件中的占位值须自行替换。
3. Compose中的NapCat WebUI token从项目.env中的NAPCAT_WEBUI_TOKEN读取；不要提交.env文件。
4. docker compose -f docker-compose.demo.yml config 检查后，再执行 docker compose -f docker-compose.demo.yml up -d --build。

管理口与WebUI仅发布到宿主127.0.0.1；容器内部BOT_HOST/ONEBOT_REVERSE_WS_HOST可为0.0.0.0，但管理和OneBot均强制token。/status和/metrics使用Authorization: Bearer头；/healthz为进程健康，/readyz未接QQ时503。

镜像以非root用户运行，data挂载须允许容器用户写入。容器内Python解释器和FFmpeg已在Dockerfile声明，系统Vision不可用。不自动发布镜像或执行QQ登录，真实QQ账号操作与端到端测试由部署者完成。
