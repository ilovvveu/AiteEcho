# 安全与隐私

维护者：ilovvveu。当前维护 AiteEcho main 分支。

## 报告漏洞

若本仓库 Security 页面已启用 Private vulnerability reporting，请通过私密漏洞报告提交。未启用时，可先提交不含漏洞细节的联系请求，由维护者提供私密渠道。不要向原作者邮箱发送本修改版的问题，也不要在公开Issue发布可利用步骤、密钥、QQ聊天或账号信息。

## 部署边界

- 默认管理 HTTP / 反向WS只监听127.0.0.1；非回环监听分别需要24字符以上的随机 BOT_ADMIN_TOKEN / ONEBOT_ACCESS_TOKEN。
- /status 和 /metrics 只接受 Bearer 请求头；不在 URL 传密钥。/healthz 和 /readyz 返回最小状态；readyz 在QQ未连接时为503。
- 管理口、NapCat WebUI和OneBot不应裸露公网，跨机使用受控网络和TLS；不要通过关闭证书验证解决连通性。
- 附件/引用/群历史不可信，不能授予命令执行或设置权限。直接API后端没有本机命令/文件工具；可选ACP的权限与能力由部署者单独审计。
- 语音、模型和联网服务是第三方服务，可能产生费用；请求超时不证明上游未处理或未计费。

## 数据留存

.env、.env.local、独立密钥、config/data、QQ缓存及日志不得提交。短期上下文有界；独立@存档仅显式启用、权限0600且不自动清理，/reset不删除它。此存档不追踪QQ撤回状态，也不能证明当前群内可见。部署者应告知参与者、限定用途、访问及留存。

发布前审查源文件、Git历史、npm包清单和Docker上下文；ignore规则本身不是安全证明。许可证和来源见 LICENSE / NOTICE。

更多数据流与权利处理提示见[功能说明](docs/features.md#数据去向与留存)及[风险与免责声明](DISCLAIMER.md)。风险声明不免除适用法律规定的安全、告知或其他法定义务。
