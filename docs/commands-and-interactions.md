# 命令系统、远端交互与工具手册 (Commands & Interactions)

本文档覆盖 **dsh-qqbot-bridge** 在 QQ 单聊侧提供的斜杠命令、翻页状态、审批与提问远端交互、Agent 出站富媒体工具以及入站附件处理机制。

---

## 1. 斜杠命令总表

入站命令解析器（[src/commands/parse.ts](../src/commands/parse.ts)）同时兼容半角 `/` 与全角 `／` 前缀，**所有命令回执均以纯文本发送**（并按 `reply_max_chars` 截断）。

### 1.1 主命令与英文别名

| 主命令 | 英文别名（大小写不敏感） | 参数 | 行为说明 |
|---|---|---|---|
| `/会话` | `/sessions`, `/ls` | `[序号 \| 标题]` | 无参时列出当前工作区会话（按最近活跃倒序，每页默认 10 条；隐藏已归档与 subagent 子会话，空白会话仅在当前正被控制时显示）；带序号或标题时切换控制目标（已归档会话不可选中） |
| `/切换` | `/switch`, `/ws` | `[序号 \| 路径 \| 标题]` | 无参时列出全部已注册工作区（含路径与非归档会话数）；带参时切换工作区作用域，**并清空当前控制目标防止误发** |
| `/新建` | `/new`, `/reset`, `/clear` | `[路径]` | 受 `allow_create_session` 开关控制。无参时在当前工作区（或默认工作区）新建会话；传入未注册路径时自动递归建目录并注册工作区，随后将控制目标切换为新建会话 |
| `/停止` | `/stop`, `/abort` | 无 | 中断当前受控会话正在运行的 Agent 回合 |
| `/状态` | `/status` | 无 | 查看当前控制目标（标题与短 ID）、所属工作区、当前模型、思考强度、权限档位、运行忙闲状态与上下文用量（受 `status_show_usage` 控制） |
| `/压缩` | `/compact` | 无 | 触发当前会话历史压缩（等价 DSH `/compact`）。先回执「正在压缩会话历史…」，完成后追加压缩条目数与 token 变化；**不支持带参数，且过程不可中断** |
| `/模型` | `/model` | `[模型名 \| provider/model]` | 直通 DSH `llm` 与 `sessionController.selectModel`：无参查看当前模型与可用列表；带参切换当前会话模型（匹配多供应商时提示指定 `provider/model`） |
| `/思考` | `/thinking`, `/think` | `[档位]` | 直通 DSH `llm.resolveModelInfo` 与 `selectModel`：无参查看当前模型支持的思考档位；带参切换思考强度（传入 `默认` / `default` 可恢复模型默认档位） |
| `/权限` | `/permission`, `/perm` | `[只读 \| 编辑 \| 完全 \| preset]` | 直通 DSH `ctx.permissionPresets`：无参查看当前及可用权限档位；带参切换权限预设（兼容中文档位与原始 preset 名） |
| `/帮助` | `/help` | 无 | 打印命令清单与简要用法 |

### 1.2 分页子命令

当 `/会话` 或 `/切换` 结果超过 1 页（默认 `list_page_size = 10`）时，列表页脚会提示翻页命令，且跨页保持**连续编号**：

| 命令 | 英文别名 | 说明 |
|---|---|---|
| `/下一页` | `/next` | 翻至下一页（仅在分页状态活跃时有效） |
| `/上一页` | `/prev` | 翻至上一页（仅在分页状态活跃时有效） |

> [!NOTE]
> 当处于分页状态时，发送非分页斜杠命令或普通消息会自动清除当前分页状态并继续正常执行，不会吞掉用户输入。未识别的斜杠命令会回执 `未知命令：...（该消息未发送给会话）`，避免误以为已发给 Agent。

---

## 2. 远端交互：审批与提问

当 Agent 运行过程中触发 DSH 官方审批或提问请求时，[src/inbound/interactions.ts](../src/inbound/interactions.ts) 通过 Cordis waterfall `{ prepend: true }` 拦截请求：

- **作用域隔离**：仅接管**当前正被 QQ 远程受控、且当前回合由 QQ 发起**的会话（`controlledBy` + `ownTurn`）；非受控会话或由 WebUI 发起的回合通过 `next()` 原样委派给 WebUI，互不干扰。
- **投递与降级**：优先通过锚点（`resolveTarget(openid)`）以 `msg_type=2` Markdown 卡片 + 内联按钮（`keyboard`）发送；若带按钮请求失败，自动剥离 `keyboard` 降级发送纯 Markdown 引导文本；若彻底无入站锚点，降级为主动消息投递。
- **双通道作答与超时**：同一 `openid` 同时只保留一个待决交互（新请求顶掉旧请求，旧请求 fail-closed）；默认等待超时 **300 秒**，超时自动 fail-closed。

### 2.1 执行审批 (`approval/request`)

- **卡片内容**：展示工具名、从最近 `tool/call`（按 `callId` 匹配，上限 500 字符）提取的命令原文代码块、审批原因，以及「允许一次 / 拒绝」内联按钮（`group_id` 为 `ap-${nonce}`）。
- **有效应答方式**：
  - 点击内联按钮（允许一次 / 拒绝）
  - 文本回复允许词：`y`、`yes`、`是`、`允许`、`同意`、`批准`、`1`、`好`、`可以`（返回 `allowed-once`）
  - 文本回复拒绝词：`n`、`no`、`否`、`拒绝`、`不同意`、`2`、`不`（返回 `rejected`）
  - 取消词：`/取消`、`/cancel`、`取消`（返回 `cancelled`）
  - 其它未识别文本不会转发给 Agent，而是按拒绝处理并明确回执提示。

### 2.2 用户提问 (`user-questions/request`)

- **卡片渲染**：多题时按序逐题串行下发。
  - **单选题**（`!multiSelect && options.length > 0`）：生成 2 列内联按钮（`group_id` 为 `q-${nonce}`，按钮标签按码点截断至最多 10 字符）。
  - **多选题或开放题**：下发纯 Markdown 列表与文本作答引导。
- **按钮回调机制**：收到 `INTERACTION_CREATE` 且 `nonce` 与选项范围校验通过后，客户端自动调用 `PUT /interactions/{id}`（`{ code: 0 }`）确认回调，并将下一题的被动回复锚点更新为 `INTERACTION_CREATE:<id>`。
- **有效应答方式**：
  - 点击单选按钮
  - 回复选项序号（单选如 `1`；多选用逗号或空格分隔如 `1,3`）
  - 直接回复自定义文本（不匹配序号时视为自定义文本答案 `custom`）
  - 回复 `/跳过` 或 `/skip` 跳过当前题
  - 回复 `/取消`、`/cancel` 或 `取消` 放弃整次提问（抛出未作答错误中止）

---

## 3. Agent 工具与入站多媒体

### 3.1 Agent 出站工具 (`send_file` / `send_image`)

[src/tools/index.ts](../src/tools/index.ts) 在 DSH `ctx.tools` 注册两个工具，供 Agent 主动向当前 QQ 单聊用户回传本地文件或图片：

| 工具名 | 对应 QQ `file_type` | 参数 schema | 说明 |
|---|---|---|---|
| `send_file` | `4`（文件） | `{ file_path: string, file_name?: string }` | 将本地绝对路径文件通过四步分片上传并以 `msg_type=7` 发回 QQ |
| `send_image` | `1`（图片） | `{ file_path: string, file_name?: string }` | 将本地绝对路径图片通过四步分片上传并以 `msg_type=7` 发回 QQ |

- 目标定位（`resolveTarget`）优先使用当前活跃回合锚点；当调用返回 `code=40054005`（slot 去重冲突）时自动换新 `msg_seq` 重试一次；当遇到 `40034005` / `40034128`（被动超限/过期）时自动剥离被动锚点降级为主动消息重试一次（复用已上传 `file_info`，不重传文件）。

### 3.2 入站附件处理

[src/qq/media-in.ts](../src/qq/media-in.ts) 负责处理 QQ 单聊消息附带的 `attachments`：

- **下载与 SSRF 防御**：对附件 URL 校验协议（仅允许 `http:` / `https:`）并拦截环回、私网及本地 Host（`localhost`、`127.0.0.1`、`10.x`、`172.16–31.x`、`192.168.x`、`100.64–127.x`、`169.254.x`、`::1`、ULA/链路本地 IPv6 等）；按 `media_max_bytes`（默认 200 MiB）限流。
- **图片魔数纠偏**：针对 QQ 网关常将非 PNG 图片统一标为 `image/png` 的问题，下载后通过文件头 magic bytes 识别真实格式（PNG / JPEG / GIF / WebP / BMP）并修正扩展名与 `MIME`。
- **上下文注入**：落盘至 `media_dir`（默认 `$DSH_HOME/qqbot/media`）后，向会话注入结构化文本摘要 `[附件 i/N] 类型：文件名（字节，MIME）已保存到 路径`；图片额外构造 `imageDataUrl` 注入多模态上下文，语音若带 `asr_refer_text` 则附带语音转写文本。
- **失败隔离**：单个附件下载失败只记错误日志，不丢弃用户的消息正文。
