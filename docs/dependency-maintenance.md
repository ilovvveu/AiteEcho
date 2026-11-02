# 依赖升级策略

运行中的实例不会因GitHub合并自动更新；部署、重启、API与网络设置是独立操作。

## 自动提案

- npm生产与开发依赖只将minor/patch更新合并成组，仍须通过完整CI后人工合并。
- 暂停自动提出ACP SDK、TypeScript、Vitest的跨大版本更新：ACP SDK 2.x删除了本项目使用的旧连接接口；当前ESLint工具链与TypeScript 7不兼容；Vitest 5应单独迁移，不与其他工具一起盲升。
- 这些限制不阻止必要的手工安全修复。发现漏洞时应单独评估，不以忽略规则作为永久保留有漏洞版本的理由。
- GitHub Actions按独立组更新。版本变更须审查工作流差异及权限，不能仅凭绿色检查自动批准。
- Dependabot使用仓库级dependencies和maintenance标签；新建仓库时应创建它们，配置文件不会自动创建标签。

## 验证与发布

1. 在不含.env、聊天、密钥或运行数据的独立源码副本中改动并保留恢复点。
2. 保留待迁移工具的大版本与现有锁定版本，分开检查其他包及传递依赖的实际变化。不得用--force或--legacy-peer-deps掩盖兼容冲突。
3. 在Node22与24运行npm ci、lint、typecheck和完整测试；执行生产build、仅本地虚拟API/OneBot的smoke:build、audit:release及npm audit。
4. 复核公开文件清单、已知私人部署值和提交匿名邮箱，再提交审阅并核对远端CI。CI成功不代表真实QQ客户端或所有平台已验收。
5. 若替代失败的升级提案，说明保留的大版本、已纳入的更新与验证结果后关闭旧提案；不清理用户运行数据或旧备份。

当前的大版本迁移留给独立任务，不能通过关闭失败检查、放宽私有值扫描或强制安装来达到“通过”。

配置语义参见[GitHub官方Dependabot选项说明](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)。
