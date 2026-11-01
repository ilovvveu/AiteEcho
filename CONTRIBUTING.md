# 参与 AiteEcho

维护者：[ilovvveu](https://github.com/ilovvveu)。问题和PR请提交到本仓库，不要发往上游维护入口。

- 先描述可复现的问题，再提交聚焦改动。
- 使用 Node.js 22/24；npm ci 后运行 npm run check、npm run build、npm run smoke:build 和 npm run audit:release。
- 文档测试依赖见 scripts/requirements-test.txt；可用 QQ_DOCUMENT_TEST_PYTHON 指定解释器。
- 不提交真实 API key、QQ号/群号、聊天、账户配置、日志、缓存或本机绝对路径。
- 新能力不得绕过主人权限、群隔离、真实@要求、限频、附件来源校验或 POST 防重放。
- 变更配置须同步 .env.example 与 docs/configuration.md，增加失败路径测试。
- 保留 LICENSE/NOTICE；测试通过不代表真实QQ、容器或跨平台验收。

安全问题请遵循 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中粘贴漏洞细节和敏感材料。
