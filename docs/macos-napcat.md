# macOS + NapCat辅助工具

通用启动主线见[快速开始](getting-started.md)，推荐构建后npm start；npm run dev只用于开发。本页是可选的本机QQ注入/运维工具，必须先理解其副作用，不是远程部署脚本，也不管理已有launchd服务。

## 先配置，再按需执行

.env/.env.local中自行填写ONEBOT_ACCESS_TOKEN和NAPCAT_WEBUI_TOKEN：至少24个随机字符，且两者不同，没有可用的默认口令。安装与运维命令在校验凭据前不会停止QQ或写配置；不要把密钥写在命令行历史中。

~~~sh
npm run status:napcat:macos
npm run setup:napcat:macos
npm run launch:napcat:macos -- --restart
~~~

- status：检查本机QQ/NapCat文件和进程；状态输出隐藏token及URL中的凭据/查询。
- setup：从NapCat官方GitHub下载Shell、备份并修改QQ入口、写OneBot/WebUI配置；可能停止QQ，属于有副作用操作。新包须有napcat.mjs，旧Shell改名保留恢复副本，不先删除旧安装。
- launch --restart：明确允许重启QQ时才执行，会以NapCat所需模式启动QQ。
- restore:qq:macos：从原入口备份恢复；QQ运行中应先停止，或显式选择重启流程。

默认QQ.app为/Applications/QQ.app，反向WS为ws://127.0.0.1:16700/onebot/v11/ws；WebUI为http://127.0.0.1:6099/webui。可通过QQ_APP_PATH、ONEBOT_REVERSE_WS_PORT/PATH和各token配置；非默认QQ路径与不同系统权限须单独验证。

## bot:macos辅助模式

先npm run build。随后可按需要使用：

~~~sh
npm run bot:macos -- status
npm run bot:macos -- up
npm run bot:macos -- login
~~~

status会读取管理状态和NapCat登录状态（包含本机认证请求），不停止应用。login可能刷新登录二维码、启动或重启QQ，不是只读命令。up会停止QQ、更新注入配置、停止这个目录自己管理的bot，再启动bot及QQ；repair也会停止QQ并重启bot。使用--json时登录输出包含临时二维码/账号资料，不应公开粘贴。

工具只接受已记录PID、精确命令和相同工作目录共同证明属于本项目的bot；不再用pkill匹配所有node dist/index.js。无法证明归属则拒绝，不强杀别的项目。不会自动接管launchd管理的生产副本。启动时保留操作者配置，不强制开放群聊/私聊、替换API/agent或开启verbose；管理token由请求头传递。

配置写入0600并拒绝目标软链接。QQ入口原文件保留备份；修改app bundle仍可能被macOS阻止。不要为跳过错误自动关闭系统安全或随意扩大权限，先核对具体文件/授权。

## 验证边界

工具的凭据检查、脱敏、PID归属和文件保护可用本地合成测试验证；这不等于真实QQ安装、扫码登录和客户端收发已在所有版本通过。当前本地整理未执行这些有副作用命令。NapCat/QQ为独立第三方项目，不随此仓库分发。
