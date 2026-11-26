# 系统架构与实现机制 (Architecture)

本文档从代码模块视角阐述 **dsh-qqbot-bridge** 的运行时装配、入站处理管线、DSH 会话接管模型、出站流式状态机与 QQ Bot API v2 协议适配机制。

---

## 1. 总体架构

```text
+-----------------------------------------------------------------------------------+
|                            DeepSeek Harness (DSH) Host                            |
|  agents · workspaceRegistry · sessionProjections · storageDomain · tools · llm    |
+-----------------------------------------------------------------------------------+
                 ^                                                 |
                 | control / user/message / approvals / tools      | agent/assistant-stream
                 |                                                 v session/event
+-----------------------------------------------------------------------------------+
|                             dsh-qqbot-bridge (Cordis)                             |
|                                                                                   |
|  [InboundPipeline] ──> [ControlService + TargetStore]                             |
|    (审批/提问/分页/     (storageDomain 持久化; live 复用,                         |
|     命令/首次引导/       排他锁不降级; user/message 归属追踪)                      |
|     入站附件)                                                                     |
|         │                                                                         |
|         v                                                                         |
|  [QqInteractions]     [CommandDispatcher]     [TurnRouter]                        |
|   (waterfall prepend)  (纯文本回执 + 截断)     (过滤 text-delta; per-step 流/整发) |
|         │                     │                       │                           |
|         └─────────────────────┴───────────────────────┘                           |
|                               │                                                   |
|                               v                                                   |
|  [QqStreamManager + MsgSeqSlotAllocator + PerPeerSerialSender + QqMarkdownAdapter]|
|  [QqMediaSender / QqMediaReceiver + sendWithProactiveFallback]                    |
|                               │                                                   |
|                               v                                                   |
|  [QqClient] (Singleflight Token · Node WebSocket Gateway · REST QqApiResult)      |
+-----------------------------------------------------------------------------------+
                                ^                                 |
                                | QQ Official Bot API v2 (C2C)    v
                         [QQ Open Platform: Gateway WS + OpenAPI REST]
```

---

## 2. Cordis 插件装配与生命周期

插件主入口位于 [src/index.ts](../src/index.ts)：

- **必需服务注入**：`export const inject = ['agents', 'workspaceRegistry', 'sessionProjections', 'storageDomain']`；其余官方服务（`settings`、`llm`、`sessionController`、`permissionPresets`、`sessions`、`tools`、`sessionTitle`、`sessionQuery`、`sessionObservation`、`compaction` 等）通过 `ctx.get(...)` 按需显式读取。
- **`apply()` 与 `wire()` 分离**：`apply()` 在 `ready` 后异步执行旧版配置迁移（`migrateLegacyConfig`）、注册 `settings.configure({ auto: false }, ctx.fiber)`（声明使用自定义卡片）、调用 `wire()` 完成全链路装配并监听 `loader/volatile-update` 触发热对齐。
- **离线待机与热上线**：若初始凭据缺失，`wire()` 仍挂载 `/plugins/dsh-qqbot-bridge/config` 路由并监听设置更新事件；当用户后续保存有效凭据时，`reconcile()` 自动拉起完整 `createWiring()` 并启动客户端。

---

## 3. 入站决策管线 (`src/inbound/pipeline.ts`)

每条 C2C 入站消息按严格优先级流经以下阶段（任一阶段命中消费后即终止向下传递）：

1. **审批待决拦截**：`approval.hasPending(openid)` 命中时，即使消息形如斜杠命令也优先交由审批槽位消费（允许词 / 拒绝词 / `/取消`）。
2. **提问待决拦截**：`question.hasPending(openid)` 命中时，优先消费为当前提问的答案（序号 / 自定义文本 / `/跳过` / `/取消`）。
3. **非斜杠消息处理**：清理可能残留的分页态，执行未选中态检查（`allow_create_session` 开启且无目标时自动在默认/当前工作区建会话），随后注入入站附件并投递给目标会话。
4. **斜杠命令分发**：解析半角 `/` 或全角 `／` 命令并映射英文别名；若当前处于分页态且不是翻页子命令则先退出分页；已知命令经 `CommandDispatcher` 执行并按需处理异步 `followUp`（如 `/压缩`）；未知命令直接回执「该消息未发送给会话」。

---

## 4. DSH 会话接管与回合归属

### 4.1 持久化目标与工作区对齐 (`src/dsh/target-store.ts`, `src/dsh/control.ts`, `src/dsh/workspaces.ts`)

- 通过 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain` / `domainTable` 将 `{ openid -> { workspaceId, sessionId, updatedAt } }` 持久化存储，跨进程重启可自动恢复控制目标。
- 会话可见性与排序与 WebUI 保持一致：读取 `workspaceRegistry` 与 `sessionQuery` / `sessionObservation`，过滤已归档会话、隐藏 `subagent` 子会话，并对非当前受控的空白会话予以隐藏；相对时间标签对齐 WebUI 档位。

### 4.2 接管语义与并发安全

- 通过 `ctx.agents.get(sessionId)` 优先复用同进程内的 live agent 实例；若会话空闲或需恢复则调用 `ctx.agents.resume({ sessionId })`。
- **绝不降级新建**：遇排他锁占用（如 WebUI 正在使用该会话）或恢复失败时如实向 QQ 回执提示，绝不静默新建会话顶替。
- 对正在运行中的同一会话发送新消息，走 DSH `steer` 注入当前回合；空闲时走常规 `followup` 投递。

### 4.3 回合归属追踪 (`turnOrigin` + `anchors`)

- [src/index.ts](../src/index.ts) 监听 `session/event` 中的 `user/message`（`source.kind === 'user'`）：若消息 `id` 属于本桥接 `control.send()` 记录的自发消息 ID，则将该会话当前回合标记为 `'qq'`，否则标记为 `'other'`。
- `TurnRouter` 与 `QqInteractions` 均通过 `ownTurn(sessionId)` 检查归属：**只有 QQ 发起的回合才将回复流推送到 QQ 或由 QQ 接管审批/提问卡片**，避免把用户在 WebUI 发起的对话误镜像到 QQ。
- [src/dsh/anchors.ts](../src/dsh/anchors.ts) 为每个 `openid` 维护与回合绑定的入站 `msgId` 锚点，确保长耗时多步回复不会因期间到达的新消息而串改被动回复目标。

---

## 5. 出站流式状态机与降级链路

### 5.1 回合路由与串行化 (`src/outbound/turn-router.ts`, `src/outbound/queue.ts`)

- `TurnRouter` 监听 `agent/assistant-stream` 与 `session/event`，**仅放行 `chunk.type === 'text-delta'`**，丢弃 `reasoning-delta`、`tool-call-delta`、`block-*`、`usage`、`finish` 等中间态帧。
- 按 `openid` 维护独立的 Promise 串行链（`chain`），确保 Cordis `emit` 同步发射下的异步网络发送严格有序；`drainPeer(openid)` 用于在发送普通消息（如卡片或命令回执）前等待当前流片结算完成，避免文本被半路截断。
- 每个 `attempt`（step）的 `end`（`outcome.kind === 'committed'`）视为一段逻辑输出边界；`turn/end` 作为最终兜底收尾。

### 5.2 QQ 流式协议与槽位分配 (`src/qq/stream.ts`, `src/qq/markdown.ts`, `src/qq/passive-fallback.ts`)

- **单流单槽位**：每条流式消息在 `open` 时通过 `MsgSeqSlotAllocator` 为所属 `msg_id` 分配一个唯一的 `msg_seq`，整段流式内保持不变，分片靠自维护全局单调递增的 `index` 区分（不透传 DSH per-attempt 归零的 `chunk.index`）。
- **Markdown 最小修补与按字节切分**：`QqMarkdownAdapter` 仅做 `#标题 → # 标题` 与合法 UTF-16/控制字符清洗，不做全局截断；单次流式请求按 UTF-8 字节上限 `8 KiB` 切分，非流式普通消息按 `16 KiB` 切分（均优先按换行边界切分，绝不切坏代理对）。
- **两级兜底**：
  1. 流式通道（`stream_messages`）失败时，在 `settle` 阶段分配新的 `msg_seq` 槽位降级为普通 `msg_type=2` Markdown 消息发出；
  2. 普通消息或富媒体发送若命中平台错误码 `40034005`（被动 `msg_id` 过期）或 `40034128`（被动回复超限），`sendWithProactiveFallback()` 自动剥离 `msg_id` / `event_id` / `msg_seq` 降级为主动消息重试一次。

---

## 6. QQ 协议客户端与客户端设置面板

- **协议客户端 ([src/qq/client.ts](../src/qq/client.ts))**：
  - `getAccessToken()` 使用 singleflight 防并发重复请求，过期前 60 秒主动刷新，REST 遇 `401` 时强制刷新并重试一次；
  - Gateway WS 订阅 `intents = (1 << 25) | (1 << 26)`（`GROUP_AND_C2C_EVENT` 与 `INTERACTION`），内置 15 秒 `HELLO` 看门狗、`0.8 * heartbeat_interval` 心跳、指数退避重连（`2s/5s/10s/30s/60s`）与 `RESUME` 恢复。
- **WebUI 设置客户端 ([src/client/index.tsx](../src/client/index.tsx), [scripts/build-client.ts](../scripts/build-client.ts))**：
  - 使用 `esbuild` 编译为 DSH `window.__ModuleLoader__` lazy-CJS 格式（`dist/client.js`），通过 `slots` 注入 DSH 设置界面；支持 `revision` 乐观锁冲突检测、字段级「已自定义 / 重置」及「放弃修改 / 保存更改」。
