# 常见问题排查与协议边界 (Troubleshooting)

本文档汇总 **dsh-qqbot-bridge** 在安装、配置、连接与日常使用中的常见问题，以及代码已显式处理的 QQ 官方 Bot API v2 协议约束。

---

## 1. 启动与连接问题

### 1.1 启动后机器人不回复，日志提示「QQ 凭据缺失，插件处于离线待机」

- **原因**：环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`、`$DSH_HOME/.credentials.yaml` 的 `refs`、以及插件配置 `app_id` / `app_secret` 均未提供完整凭据。
- **处理**：
  - 在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下写入 `QQ_BOT_APP_ID` 与 `QQ_BOT_SECRET` 后重启；
  - 或直接在 DSH WebUI **「QQ 机器人」→「连接」** 设置卡片填写 `AppID` 与 `AppSecret` 并保存，插件会自动热上线。

### 1.2 本地源码 `link:.` 安装后修改未生效

- **原因**：DSH 通过 `package.json` 的 `main`（`dist/index.js`）与 `./client`（`dist/client.js`）加载构建产物。只修改 `src/` 而未执行构建时，运行时仍执行旧的 `dist/`。
- **处理**：每次修改源码后执行 `pnpm build`，再启动或重载 DSH。

### 1.3 Gateway 鉴权失败（`401`）或频繁重连

- **排查项**：
  1. 检查 `AppID` 与 `AppSecret` 是否有多余空格或已过期重置；
  2. 检查 QQ 开放平台后台是否配置了 IP 白名单而未包含当前运行机器的公网出口 IP；
  3. 检查本地代理或防火墙是否拦截了 `https://bots.qq.com`、`https://api.sgroup.qq.com` 或长连接 WebSocket；
  4. `QqClient` 内置 15 秒 `HELLO` 看门狗与指数退避重连（`2s → 5s → 10s → 30s → 60s`），网络恢复后会自动尝试重连与 `RESUME`。

---

## 2. 会话控制与权限提示

### 2.1 发送消息后回执「该会话正被占用（可能正在被 WebUI 使用）」

- **原因**：DSH 对同一会话持有排他锁。当 WebUI（或其它进程）正在占用该会话的 live agent 实例时，插件不会抢锁，也不会静默降级新建空白会话。
- **处理**：等待 WebUI 回合结束或关闭占用页签后重试，或使用 `/会话` 切换到其它空闲会话。

### 2.2 发送消息或 `/新建` 提示不允许新建会话

- **原因**：配置项 `allow_create_session` 被关闭（默认为 `true`）。关闭后，`/新建` 与「未选中会话时直发普通消息自动新建」均会被拒绝。
- **处理**：使用 `/会话` 选择已有会话，或在 WebUI **「QQ 机器人」→「行为」** 开启 **允许新建会话** 并保存（热生效）。

### 2.3 WebUI 发起对话后，QQ 没有收到同步输出或审批卡片

- **设计如此**：插件按回合来源区分归属（`ownTurn`）。只有从 QQ 发起的回合，其流式正文与审批/提问卡片才会路由到 QQ；用户在 WebUI 自行发起的回合完整保留在 WebUI 侧处理。

---

## 3. QQ 官方 Bot API v2 常见错误码与代码应对

| 错误码 | 含义与触发场景 | 代码侧处理策略 |
|---|---|---|
| `40054005` | `(msg_id, msg_seq)` 重复去重（同一 `msg_id` 复用相同 `msg_seq`，且去重记账可能跨天残留） | `MsgSeqSlotAllocator` 为同 `msg_id` 分配递增槽位；富媒体遇 `40054005` 自动换新 `msg_seq` 重试一次 |
| `40034005` / `40034128` | 被动回复 `msg_id` 已过期，或被动回复时间/次数超限 | 平时仍按被动回复下发；真实返回上述错误码时，自动剥离 `msg_id` / `event_id` / `msg_seq` 降级为主动消息重试一次 |
| `40034011` | `msg_type=2` 缺少或传入空 `markdown.content` | `QqClient` 在发送前强制校验并归一化载荷 |
| `40054018` | 单次流式请求 `content_raw` 超出字节上限（实测阈值约 20 KiB UTF-8 字节） | `QqStreamSession` 按 `8 KiB` UTF-8 字节上限分段切分 `append` 下发 |
| `50015001` | 无 `msg_id` 调用 `stream_messages` 主动流式（平台不支持主动流式） | 无入站 `msg_id` 锚点时自动改走普通 Markdown 主动消息 |
| `40011021` | `keyboard` 按钮 `group_id` 过长或格式无效 | 卡片渲染限制为短前缀 `ap-${nonce}` / `q-${nonce}`（≤ 11 字符）；带按钮失败时自动降级为无按钮纯 Markdown |

---

## 4. 开发调试与真机探针脚本

[package.json](../package.json) 提供了用于隔离排查协议与 DSH 行为的探针脚本（运行前需在 `$DSH_HOME/.credentials.yaml` 或环境变量准备好测试凭据，原始日志落盘在 `.gitignore` 忽略的 `logs/` 目录）：

| 命令 | 脚本 | 用途 |
|---|---|---|
| `pnpm probe:qq` | `scripts/probe-qq.ts` | 验证 QQ Gateway、单聊收发、流式与富媒体分片基础链路 |
| `pnpm probe:e3` | `scripts/probe-e3-length.ts` | 探测单次流式与普通消息 UTF-8 字节上限 |
| `pnpm probe:e11` | `scripts/probe-e11.ts` | 观测 DSH `agent/assistant-stream` 帧序列与 `text-delta` |
| `pnpm probe:e12a` | `scripts/probe-e12a.ts` | 探测同进程 live agent 复用与并发语义 |
| `pnpm probe:e12b` | `scripts/probe-e12b.ts` | 探测会话状态、模型/思考与压缩行为 |
| `pnpm probe:webui-sync` | `scripts/probe-webui-sync.ts` | 验证插件建会话与 WebUI 同进程实时同步 |
| `pnpm probe:session-list` | `scripts/probe-session-list.ts` | 验证会话列表可见性与相对活跃时间口径 |
| `pnpm probe:first-message` | `scripts/probe-first-message.ts` | 验证首次直发自动建会话流程 |
| `pnpm check:privacy` | `scripts/privacy-guard.ts` | 扫描工作区与暂存区是否存在未脱敏的真实凭据或身份 ID |

> [!NOTE]
> 关于探针实验的测试环境前提（创建者管理员账号限制等）与历史实测记录，请参阅 [devlog/README.md](../devlog/README.md)。
