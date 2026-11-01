# ACP Agent 接入

这个项目不会直接调用某个模型平台 SDK，它只做一件事：启动你配置的本地 agent，然后通过 ACP 和它通信。

这意味着它很适合放在 **DeepSeek** 或其他本地 / 自托管模型能力的前面，作为一层 **QQ / OneBot 11 接线 + session orchestration + progress streaming** 基础设施。

## bot 是怎么接 agent 的

bot 会按下面这三个配置启动 agent 进程：

```env
ACP_AGENT_COMMAND=your-acp-agent-command
ACP_AGENT_ARGS_JSON=["arg1","arg2"]
ACP_AGENT_WORKDIR=/path/to/your/workdir
```

含义分别是：

- `ACP_AGENT_COMMAND`：可执行文件或启动命令
- `ACP_AGENT_ARGS_JSON`：参数数组
- `ACP_AGENT_WORKDIR`：启动目录，同时也会作为 ACP session 的 `cwd`

agent 进程启动后，bot 通过 stdin / stdout 上的 ACP 流和它通信。

## 哪些 ACP 能力会影响 bot 行为

必需的是：

- `initialize`
- `newSession`
- `prompt`

可选但建议支持的是：

- `loadSession`：这样 bot 才能真正复用远端 session
- `closeSession`：这样 bot 在退出时可以更干净地关闭会话
- `promptCapabilities.image`：这样 bot 才能把入站图片转给 agent

补充说明：

- 当前 richer media 还在分阶段演进
- **文本 + 图片** 是现在的稳定主链路；图片会先经过数量、体积、来源网络和文件签名校验
- 没有可用 URL 的 OneBot 图片会尝试通过受控 `get_image` 解析；消息直接提供的本地路径始终拒绝，`get_image` 返回的路径也只能位于显式配置的缓存根目录内；私网跳转和非 QQ CDN 地址仍会被拒绝
- 如果只成功传入部分图片，bot 会把成功数和失败原因告诉 agent，要求它不得假装看到了缺失图片
- macOS 可选开启本机 Vision OCR；OCR 文本作为不可信数据附加，不会被当作系统指令
- 如果用户发来 **语音 / 文件 / 视频** 等当前 bot 还不会自动直传给 agent 的媒体，bot 会在 prompt 里显式附带一段“未直传媒体”说明，要求 agent 不要假装已经读取了附件内容
- 这能避免“附件其实没传过去，但 agent 还像看过了一样回答”的错误观感

如果 agent 会持续发送下面这些增量更新，bot 就能把处理进度回发到 QQ：

- `plan`
- `tool_call`
- `tool_call_update`
- `agent_message_chunk`

## 最快可跑通的方式：仓库自带 mock agent

如果你现在只想先验证 QQ ↔ bot ↔ ACP 这条链路，不想先装外部 agent，可以直接用仓库自带的 mock agent。

```env
ACP_AGENT_COMMAND=node
ACP_AGENT_ARGS_JSON=["--import","tsx","src/examples/mock-acp-agent.ts"]
ACP_AGENT_WORKDIR=/path/to/qq-ai-bot
```

然后运行：

```bash
npm run smoke:agent
```

这个 mock agent 会返回固定的计划、工具调用和文本片段，适合联调链路和进度播报。

## `traex` 示例

如果你使用 `traex`，对应配置通常是：

```env
ACP_AGENT_COMMAND=traex
ACP_AGENT_ARGS_JSON=["acp","serve"]
ACP_AGENT_WORKDIR=/path/to/your/workdir
```

你可以用通用 smoke 命令：

```bash
npm run smoke:agent
```

也可以继续用仓库保留的便捷脚本：

```bash
npm run smoke:traecli
```

如果这里把 `ACP_AGENT_ARGS_JSON` 写成 `[]`，很多安装下拉起的会是交互界面而不是 `acp serve`，最终表现成 `ACP connection closed`。推荐始终显式写成 `["acp","serve"]`。

如果你的 `traex` 或其他 ACP runtime 背后接的是 **DeepSeek**，`qq-ai-bot` 这一层通常不需要特殊改动；它只关心 ACP 协议是否能正常拉起、收发消息和复用 session。

## 自定义 agent 示例

如果你已经有自己的 ACP agent，可执行文件叫 `my-agent`，启动参数是 `serve --stdio`，那配置就是：

```env
ACP_AGENT_COMMAND=my-agent
ACP_AGENT_ARGS_JSON=["serve","--stdio"]
ACP_AGENT_WORKDIR=/path/to/your/workdir
```

配置完成后，验证方式仍然一样：

```bash
npm run smoke:agent
```

## 切换 agent 时真正要改的只有三项

如果你要把当前 bot 从一个 agent 切到另一个 agent，通常只需要改：

- `ACP_AGENT_COMMAND`
- `ACP_AGENT_ARGS_JSON`
- `ACP_AGENT_WORKDIR`

群聊策略、命令体系、会话持久化、OneBot 11 接入这些都不用跟着重写。
