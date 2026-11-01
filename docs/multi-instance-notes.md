# Multi-instance notes / 多实例运维说明

这份文档面向已经跑通单实例、准备把 `qq-ai-bot` 放到更长期运行环境里的 operator。

先说结论：

- 第一次接入、个人使用、小规模群聊，优先保留单实例。
- 需要容器重建后保留会话、或者准备横向扩容时，再把 `SESSION_STORE` 从 `file` 切到 `redis`。
- Redis 解决的是会话状态外置化，不等于自动拥有分布式锁、严格 exactly-once 或跨实例 replay guard。
- 多实例前先明确 OneBot WebSocket 事件会落到哪个实例，避免同一条 QQ 消息被多个 bot 实例同时处理。

相关背景可以先看：

- [Deployment patterns / 部署形态](deployment-patterns.md)
- [Deployment matrix / 部署组合矩阵](deployment-matrix.md)
- [配置说明](configuration.md)
- [FAQ / 常见问题](faq.md)

---

## 什么时候保留单实例更好

下面这些场景不建议急着上多实例：

- 你还在验证 **QQ -> OneBot -> qq-ai-bot -> ACP agent** 链路是否打通。
- 只有一个 NapCat / LLOneBot 实例和一个 bot 进程。
- 主要目标是本机、单服务器或少量群聊长期运行。
- 你还没有明确 agent runtime 是否支持 `loadSession`。
- 你还没有 `/readyz`、`/status`、`/metrics` 的基础观察方式。

这时默认的 file store 更简单：

```env
SESSION_STORE=file
SESSION_FILE_PATH=./data/sessions.json
SESSION_TTL_MINUTES=120
```

单实例不是“低级形态”。对 messaging bridge 来说，它通常是最稳、最容易排查的默认路径。

---

## 什么时候该切 Redis

下面这些信号出现时，Redis store 更合适：

- 容器、Pod 或进程可能被重建，不希望会话只留在本地 JSON 文件里。
- 你准备让多个 `qq-ai-bot` 实例共享 conversation state。
- 你希望不同实例使用同一批已持久化的 QQ conversation -> ACP remote session 映射。
- 你希望把 session TTL、key 前缀和数据生命周期交给外部存储统一管理。

推荐的最小配置：

```env
SESSION_STORE=redis
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_KEY_PREFIX=qq-ai-bot-prod
SESSION_TTL_MINUTES=120
```

更接近生产时建议：

- `REDIS_URL` 指向有持久化、备份和监控的 Redis，而不是随容器一起丢失的临时实例。
- 同一套 bot 实例使用同一个 `REDIS_KEY_PREFIX`；不同环境使用不同前缀，例如 `qq-ai-bot-prod` / `qq-ai-bot-staging`。
- `SESSION_TTL_MINUTES` 至少覆盖你希望保留上下文的静默窗口。
- Redis 网络访问只暴露给 bot 运行环境；如果你的 Redis 提供认证或 TLS，优先打开。

注意：Redis store 主要保存 `qq-ai-bot` 侧的 conversation state 和 remote session hint。真正的 agent 上下文是否能恢复，还取决于后端 ACP agent 是否支持 `loadSession`。如果 agent 不支持，bot 会退回新建 ACP session。

---

## 当前支持边界

现在可以依赖的能力：

- `SESSION_STORE=redis` 会把会话记录写入 Redis key，并维护一个 session key 集合用于列出持久化会话。
- session TTL 与 `SESSION_TTL_MINUTES` 对齐。
- `/status`受管理鉴权保护，显示sessionStore、OneBot及去重状态；`/readyz`仅提供最小QQ连接就绪布尔值。
- `/metrics` 会暴露 OneBot 连接、会话数、入站 / 出站消息、重复入站、ACP prompt 和错误计数。
- `correlationId` 会帮助你把同一轮 QQ -> OneBot -> ACP -> reply 日志串起来。

当前非目标：

- 不提供分布式锁。
- 不提供严格 exactly-once。
- 不提供跨实例共享的入站 replay guard。
- 不保证多个 bot 实例同时消费同一 OneBot 事件时只处理一次。
- 不自动配置负载均衡、WebSocket sticky session 或 OneBot fan-out 策略。

尤其要记住：轻量入站去重是单实例内存级缓存。它能降低 OneBot 重连或短时间重放带来的重复 prompt，但不是跨实例幂等系统。

---

## OneBot WebSocket 和负载均衡注意事项

OneBot 接入是多实例里最容易误判的地方。它不是普通短请求 API，而是长连接。

### Reverse WebSocket

reverse 模式下，`qq-ai-bot` 监听 WebSocket，NapCat / LLOneBot 回连进来。

建议：

- 先让一个 OneBot 连接稳定落到一个 bot 实例。
- 如果前面有负载均衡，确认它支持 WebSocket upgrade 和足够长的 idle timeout。
- 不要把同一个 OneBot 实现配置成同时回连多个 bot 实例，除非你确认它不会把同一条事件广播给所有连接。
- 如果你使用多副本服务地址，优先把它当作故障切换入口，而不是默认事件并行处理入口。

### Forward WebSocket

forward 模式下，`qq-ai-bot` 主动连接 OneBot 侧的 WebSocket 服务。

建议：

- 不要默认启动多个 bot 副本同时连到同一个 OneBot forward endpoint。
- 先确认你的 OneBot 实现对多个 client 的事件投递语义：是每个 client 都收到，还是只交给一个 client。
- 如果每个 client 都会收到事件，就需要额外的路由或幂等设计；当前 bot 不会替你做跨实例协调。

### 一个更保守的演进顺序

更稳的顺序通常是：

1. 单实例 + file store 跑通。
2. 单实例 + Redis store 跑通。
3. 单 OneBot 连接 + Redis store + 可重建 bot 容器。
4. 明确 OneBot 事件路由后，再增加 bot 副本。

---

## 从单实例迁移到多实例的步骤清单

1. 记录当前单实例版本：通过带管理鉴权的`/status`确认`build`、`sessionStore`和`onebotMode`。
2. 跑通一次真实消息：确认 `/metrics` 里 `qq_ai_bot_inbound_messages_total`、`qq_ai_bot_outbound_messages_total` 会增长。
3. 准备 Redis：确认 Redis 有持久化、监控、访问控制和足够的内存。
4. 只改一个实例到 Redis：

   ```env
   SESSION_STORE=redis
   REDIS_URL=redis://redis.example.internal:6379/0
   REDIS_KEY_PREFIX=qq-ai-bot-prod
   SESSION_TTL_MINUTES=120
   ```

5. 按运维流程重启目标实例，通过带管理鉴权的`/status`确认`sessionStore=redis`。
6. 发一条消息，确认 Redis 里出现 `qq-ai-bot-prod:session:*` 和 `qq-ai-bot-prod:sessions`。
7. 重启 bot，再发同一个会话的消息，观察是否复用了远端 ACP session。这个结果取决于 agent 的 session 能力。
8. 在只保留一个 OneBot 事件入口的情况下，先验证容器重建、滚动发布和 Redis TTL。
9. 准备第二个 bot 实例前，先写清楚 OneBot 连接策略：一个连接、故障切换、还是多 client。
10. 增加第二个实例后，先用少量群或测试账号观察重复消息、重复进度播报和 ACP prompt 次数。
11. 确认无重复消费后，再扩大流量。

如果第 10 步发现重复处理，优先回退到单 OneBot 入口，而不是调大去重窗口。当前去重窗口不能解决跨实例重复投递。

---

## 建议监控什么

至少看这些入口：

- `GET /readyz`：仅表示OneBot是否连接；不能代表模型健康或返回配置详情。
- `GET /status`：构建版本、session store、OneBot 模式、配置摘要。
- `GET /metrics`：Prometheus 风格运行指标。
- JSON 日志里的 `correlationId`：排查同一轮消息的完整链路。

`/metrics` 里优先关注：

- `qq_ai_bot_onebot_connected`
- `qq_ai_bot_onebot_reconnect_attempts`
- `qq_ai_bot_active_conversations`
- `qq_ai_bot_persisted_conversations`
- `qq_ai_bot_inbound_messages_total`
- `qq_ai_bot_inbound_duplicates_total`
- `qq_ai_bot_outbound_messages_total`
- `qq_ai_bot_acp_prompt_calls_total`
- `qq_ai_bot_acp_prompt_failures_total`
- `qq_ai_bot_errors_total`

多实例下的异常信号通常包括：

- inbound 增长一次，ACP prompt 增长多次。
- 同一条 QQ 消息收到多条进度播报或最终回复。
- 某个实例 `onebot_connected=0`，但仍然被认为是可处理消息的实例。
- Redis session 数量和真实活跃会话明显不匹配。
- `acp_prompt_failures_total` 在滚动发布或重连期间突然升高。

---

## Rollback / 回退建议

如果多实例出现重复消费或状态不一致，优先这样回退：

1. 暂停新增 bot 副本，只保留一个 OneBot 事件入口。
2. 保留 Redis 配置，让 session state 不丢。
3. 确认单实例恢复稳定后，再排查负载均衡和 OneBot 多 client 语义。
4. 如果 Redis 本身异常，再切回 `SESSION_STORE=file`，但要接受 Redis 中的 session hint 不会自动写回本地 JSON。

这套仓库当前更愿意明确边界，而不是把“支持 Redis”包装成“天然支持任意规模横向扩容”。先把事件路由和会话恢复跑稳，再谈多实例数量。
