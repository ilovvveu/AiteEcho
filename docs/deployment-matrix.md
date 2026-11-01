# 部署支持边界

| 组件/环境 | 状态与限制 |
| --- | --- |
| macOS ARM64 / Node24 | 主要本地验证环境；具体测试见release-audit.md |
| Linux / Node22、24 | CI目标；远端任务完成前不视为已通过 |
| Docker | 提供本机构建配置；镜像构建与QQ端到端分别验收 |
| Windows | 保留通用Node后端，未作真机承诺；文档脚本resource限制依赖POSIX，默认关闭文档 |
| Vision OCR | 仅macOS，需要自行编译helper |
| Redis / Postgres / ACP | 可选兼容路径，单元/模拟测试不代表用户的真实服务环境 |
| QQ / NapCat | 第三方接入层，本仓库不附带程序、账号或托管承诺 |
