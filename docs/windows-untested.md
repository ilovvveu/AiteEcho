# Windows 接入说明（未验证）

> **注意：这份方案是按代码和依赖关系整理出来的接入路径，我这边没有在 Windows 上做实机验证。**
>
> bot 本身是 Node.js 项目，问题不大；不确定的主要是你选用的 QQ / OneBot 11 组合、Windows 下的 agent 启动方式，以及本机环境差异。

## 推荐思路

- QQ 侧：使用支持 OneBot 11 的实现，例如 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 或 [LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot)
- bot 侧：直接运行本仓库
- agent 侧：配置任意 ACP 兼容 agent

如果你只是想先验证链路，也可以直接使用仓库自带 mock agent，配置方式见 [ACP Agent 接入](agent-integration.md)。

## 1. 安装 Node.js 并拉起 bot

```powershell
npm install
Copy-Item .env.example .env
Copy-Item examples/group-rules.example.json examples/group-rules.local.json
npm run dev
```

## 2. 配置 `.env`

建议先用 reverse WebSocket：

```env
ONEBOT_MODE=reverse
ONEBOT_ACCESS_TOKEN=change-me
ONEBOT_REVERSE_WS_HOST=0.0.0.0
ONEBOT_REVERSE_WS_PORT=16700
ONEBOT_REVERSE_WS_PATH=/onebot/v11/ws
ONEBOT_GROUP_CONFIG_FILE=./examples/group-rules.local.json

ACP_AGENT_COMMAND=your-acp-agent-command
ACP_AGENT_ARGS_JSON=["arg1","arg2"]
ACP_AGENT_WORKDIR=C:\path\to\your\workdir
ACP_REUSE_SESSION=true
```

如果你使用 `traex`，对应配置通常是：

```env
ACP_AGENT_COMMAND=traex.exe
ACP_AGENT_ARGS_JSON=["acp","serve"]
ACP_AGENT_WORKDIR=C:\path\to\your\workdir
```

## 3. 配置 QQ / OneBot 11

把 OneBot 11 的 reverse WebSocket 指到：

```text
ws://127.0.0.1:16700/onebot/v11/ws
```

access token 也保持一致。

## 4. 先测 agent，再测 QQ

建议顺序：

1. 先跑 `npm run smoke:agent`
2. 再用 QQ 私聊机器人发一条普通消息
3. 再测群聊 `@机器人`
4. 最后测 `/status` 和 `/prompt`

## Windows 下值得先排查的点

### 1. 命令名不对

Windows 下有些 CLI 真正可执行的是 `.exe` 或 `.cmd`，不是裸命令名。

### 2. 工作目录没配对

`ACP_AGENT_WORKDIR` 要指到你希望 agent 干活的目录，不要留成默认值瞎跑。

### 3. 端口被占用

确认 `16700` 和 bot 的 HTTP 端口（默认 `8080`）没被别的程序占掉。

### 4. 路径分隔符

Windows 路径建议直接写完整绝对路径，例如：

```text
C:\path\to\your\workdir
```

## 结论

这条路理论上是通的，但目前标记为 **未验证**。如果你在 Windows 上跑通了，欢迎补一个 Issue 或 PR，把实测结果带回来。
