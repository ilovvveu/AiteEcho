# 验证范围与发布边界

AiteEcho的证据与上游旧版分开记录。当前修改版未宣称已有GHCR镜像、应用商店收录或跨平台真机认证。

- 本机主要验证环境为macOS ARM64 / Node24，源码测试、构建、隔离OneBot/API模拟与发布清单检查分别记录。
- CI配置Node22/24和Linux；只有远端任务实际完成后才能标记该平台通过。
- 容器有构建配置、非root用户及可选文档/FFmpeg依赖；没有本地Docker引擎时只能做静态上下文审查，不能称镜像已构建或运行。
- 系统Vision OCR仅macOS。语音需要第三方合成、SILK编码、OneBot确认和手机播放分别验收。
- 真实上游API测试不代表QQ群可见；OneBot回执不代表手机显示/播放。

发布检查执行 npm run check、npm run build、npm run smoke:build、npm run audit:release 和 npm audit --omit=dev。发布者须核对最终Git树、npm包、Docker上下文和实际远端提交，不发布.env/config/data/日志。当前测试摘要见 release-audit.md。
