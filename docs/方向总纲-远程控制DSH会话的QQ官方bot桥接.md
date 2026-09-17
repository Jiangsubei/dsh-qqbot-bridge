# 方向总纲：dsh-qqbot-bridge（QQ 远程控制 DSH 会话桥接）

> **状态**：待用户 review 放行（依 AGENTS.md §1.1，关键交付物须呈交用户查验）
> **产出日期**：2026-09-15
> **证据分级**（依 AGENTS.md §2.2）：本文每条结论标注【文档明写】/【源码明写】/【实测】/【推断】；【推断】项一律进入 `docs/任务包-第一期真机探针与协议空白实测.md` 的待验证清单。

---

## 1. 项目定位

**一句话**：一个**纯 DSH Cordis 插件**，让用户通过 **QQ 单聊**远程操控自己 DSH WebUI 里**已有各工作区的会话**——读它的流式输出、给它发消息、中途 steer 它、收发文件。

**这不是**"再做一个 QQ 聊天机器人"。传统桥接项目（nyagent、dsh-napcat-bridge）的模型是"**每个 QQ 用户 → 新建一个属于该用户的 DSH 会话**"；本项目反过来：

| | 传统桥接（nyagent / napcat） | 本项目 |
|---|---|---|
| 会话来源 | 桥接插件为 peer **新建** `qq-<peer>-<n>` 会话 | **接管 WebUI 已有的会话**（含历史会话） |
| 会话可见性 | QQ 会话出现在 WebUI，通常被隐藏只读 | 就是 WebUI 原会话，**双向可见可操作** |
| 用户意图 | 跟机器人聊天 | **遥控自己的开发环境** |
| 多用户模型 | 每 peer 一套上下文 | 用户自己的单聊遥控通道 |

**用户原话（方向基准）**：*"核心目标是利用 qq 远程控制 dsh 的 webui 已有的所有工作区的会话"*。

---

## 2. 范围红线

### 2.1 做

- QQ **单聊（C2C）** 接入：鉴权、WebSocket 网关、事件接收、被动回复。
- **工作区/会话枚举、选择、切换**（列出 WebUI 全部工作区与其会话，选中即接管）。
- **双向接管**：QQ 与 WebUI 可操作**同一个** DSH 会话；WebUI 侧动作静默，不回推 QQ。
- **命令系统**（自研解析，对齐旧项目）：列会话 / 切会话 / 切工作区 / 新建会话 / 模型 / 思考强度 / 权限 / 停止 / 状态 / 帮助。
- **流式输出**：整回合正文经 `agent/assistant-stream` → QQ `stream_messages`。
- **Markdown 渲染**：QQ 原生 markdown（`msg_type=2`）+ QQ 语法子集适配层。
- **文件收发**：入站附件落盘 + 注入模型上下文；出站图片/文件（分片上传）；工具化 `send_file` / `send_image`。
- **WebUI 设置卡片**：AppID/Secret、默认工作区、流式开关等。

### 2.2 不做（用户已拍板，严禁自行扩展）

- ❌ 群聊、频道、频道私信（用户判定：群聊引入复杂度且不安全）。
- ❌ 记忆、用户画像、人格注入、行为准则、主动回复/潜水冒泡、表情回应、贴表情、群管。
- ❌ 主动消息推送（WebUI 侧动作不回推 QQ）。
- ❌ 自研鉴权层（依赖官方 openid 身份 + 好友关系；见 §5.5）。
- ❌ 未经验证的额度防御逻辑（见 §5.2 与 §9-R1）。

---

## 3. 已锁定决策（用户拍板记录）

| # | 维度 | 决策 | 备选被否原因 |
|---|---|---|---|
| D1 | 项目形态 | **纯 DSH Cordis 插件**（`cordis.patch.yml` + `apply/inject`），装进现有 web profile；另配 boot helper **仅供测试/CI 装配验证** | 独立 App（nyagent 形态）需多维护启动/配置/升级一层 |
| D2 | 接入场景 | **仅单聊 C2C** | 群聊复杂度高且不安全 |
| D3 | 核心目标 | **远程控制 WebUI 已有各工作区会话** | 不是"为每个 QQ 用户建会话" |
| D4 | 映射粒度 | **一个 openid = 一个"当前控制目标"指针，可随时切** | 并行多会话输出需多路去重与标识前缀，复杂度过高 |
| D5 | 会话模型 | **WebUI ↔ QQ 双向接管同一会话** | — |
| D6 | 回推策略 | **只回 QQ 发起的 turn；WebUI 侧发起的静默** | 推 WebUI 动作必须走主动消息，受频控 + 用户「允许主动发送」开关 |
| D7 | 忙时策略 | **用 `steer` 注入当前 turn** | 拒绝会丢意图；排队行为不确定 |
| D8 | 生命周期 | **可新建会话、可切工作区；归档/删除 QQ 侧不做** | 归档语义与 WebUI 计数易踩坑 |
| D9 | 流式 | **整回合正文走流式**；工具进度/思考**绝不进 QQ**；审批与提问走普通消息；`msg_type=6` 仅作"未开流式或流式失败"的降级 | 用户实测：正文一条 + 审批/提问各一条，一般不触发额度 |
| D10 | Markdown | **QQ 原生 markdown + QQ 子集适配层** | 纯文本剥离会浪费官方原生渲染；极简透传会撞不支持语法 |
| D11 | 命令系统 | **自研解析**（对齐旧项目），**不接 `ctx.commands`** | 命令只服务于远程场景，无需出现在 WebUI |
| D12 | 文件 | 入站附件落盘+注入；出站图片/文件走**分片上传**；工具化 `send_file`/`send_image` | 官方简版上传接口不收本地字节（§5.4） |
| D13 | 鉴权 | **不自研**，依赖官方 openid + 好友关系 | 用户判定：官方鉴权足够，自研鉴权是 NapCat 那种三方 bot 才需要的 |
| D14 | 命名/位置 | `dsh-qqbot-bridge` @ `~/dsh-qqbot-bridge` | — |
| D15 | 第一期 | **先做真机探针**，再写业务实现 | 多处协议细节属"文档没写满"的空白 |
| D16 | 工程规范 | **沿用 `dsh-napcat-bridge/AGENTS.md`**（TDD 契约测试 + 禁造桩自测 + 中文 commit + docs 归档 + 子代理文件所有权隔离 + 真机交付强制 build） | — |
| D17 | 凭据 | 写入 `~/.dsh/.credentials.yaml` 的 `refs`（`QQ_BOT_APP_ID` / `QQ_BOT_SECRET`） | 与 DSH 现有凭据体系一致（nyagent `diagnosis.ts` 同款思路） |
| D51 | 文案与设置体验 | **用户可见文案统一收敛到 `src/i18n/zh-CN.ts`**（组织方式借 Y11，零依赖纯常量，服务端与 client bundle 共用）；设置卡片标题简化为「QQ 官方机器人」、字段标签只留中文通用术语、占位符只留纯格式提示、hint 去决策编号并缩为一句；QQ 回执删掉「等价于 DSH 的 …」类官方对照与「直调官方接口」类实现说明；`config/schema.ts` 字段说明与卡片 hint **同源**（禁止各写一套）。文案红线由 `tests/contract/i18n-copy.test.ts` 强制 | 保留决策编号/实现说明会让用户侧文案变成开发笔记；两套文案必然漂移 |
| D52 | agent preset 的会话记录与接管复原 | **照抄官方判据，绝不只看 header**：① `/新建` 先 `agentPresets.resolve()` 解析出**部署默认** preset id，**同一个 id** 同时用于 `meta.agentPreset`（会话记录，WebUI 预设标签的唯一判据）与 `mount(agentCtx, id)`（真正挂载的组合）；② 接管/冷 `resume` 时先读该会话的 **`agentPreset` 投影**（`sessionQuery.observeSession` → `projections.values.agentPreset`），按**记录在案的** preset 重新组合；记录缺席才落部署默认（= 官方 `composeAgent(undefined)` 语义）。解析失败**如实回报 `create-failed`**，不静默换 preset | 不写 `meta.agentPreset` ⇒ 组合对但记录缺席 ⇒ WebUI 标签 `return null`（真机 bug）；resume 无条件挂默认 ⇒ 「恢复了一个模型已无法据其行动的组合」（官方 `SessionHeader.agentPreset` 的原文理由） |

### 3.1 命令系统决策（D18–D35）

命令系统的完整拍板记录、入站状态机、寻址与分页规则、`/新建` 边界细则见
**`docs/设计方案-命令系统与远程控制状态机.md`**（该文档 §8 是命令域的**权威决策记录**，本表不重复）。

其中与整体方向强相关的四条提前在此点明：
- **D19**：`/切换 <工作区>` 会**清空控制目标**进入"未选中态"（防误发）；
- **D26**：插件**不维护自有的模型/思考/权限状态**，全部走 DSH 官方行为；
- **D30**：接管遇排他锁冲突时**绝不降级新建空会话**（旧项目实测教训，列为禁止行为）；
  并由 **E12-B 实测修正**：锁由 live agent 的 write handle 持有、13ms 即 `SessionAlreadyOwnedError`，
  **内部盲重试无意义 → 取消退避重试，改为立即如实回执**。
- **D36/D37（2026-09-15 追加）**：**首次直发引导**——未选中态直接发消息会自动新建会话并把它作为首个 prompt，
  落点**优先工作区作用域、否则默认工作区 `$DSH_HOME/workspace/default`**（惰性创建）；
  开关 `allow_create_session=false` 时退回 D19/D27 的"只提示不转发"。
  详见 `docs/交付报告-首次直发引导与默认工作区.md`。

---

## 4. DSH 基线（0.1.5-rc.1，本机已核验）

**运行环境**：`dsh --version` → `0.1.5-rc.1`；插件包位于 `~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`。

### 4.1 流式事件源（本项目最关键的一条）

- 【源码明写】**实时增量流是 agent 作用域事件 `agent/assistant-stream`**，payload `{ agent, frame }`：
  `dsh-agent/lib/types/runtime-types.d.ts:375`；`AssistantStreamFrame` 联合类型（`start` / `chunk` / `end`）在 `:106-135`。
- 【源码明写】chunk 帧内层是通用的 `StreamChunk`（`dsh-llm/lib/types/types.d.ts:359`），其判别式包含
  `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。
  → **只放行 `text-delta`**，其余一律丢弃（对齐 napcat 的过滤哲学，见 §7.1）。
- 【源码明写】**v2 会话事件表里没有 `assistant/chunk`**：`dsh-session/lib/types/types.d.ts:249-411` 只有
  `turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`system/message`、`assistant/message`、
  `assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/end-seed`。
- ⚠️ **这是 nyagent 现有流式实现整体失效的根因**：它监听 `session/event` 的 `assistant/chunk`（`nyagent/src/plugins/qq-gateway/stream.ts:329`），该分支永不触发 → `stream_enabled` 为真时一个字都发不出去。**新项目必须以 `agent/assistant-stream` 为唯一流源。**

### 4.2 会话与工作区枚举（"远程控制已有会话"的可行性依据）

- 【源码明写】`ctx.workspaceRegistry.list(): Workspace[]`（`dsh-workspace/lib/types/index.d.ts:92`）；
  `Workspace` 暴露 `path`（`:36`）、`title`（`:38`）、`sessionIds`（`:51`）、`attachSession`（`:69`）、`detachSession`（`:91`）
  —— 见 `dsh-workspace/lib/types/types.d.ts`。
- 【源码明写】`ctx.workspaceRegistry.archivedSessionIds`（`dsh-workspace/lib/types/index.d.ts:116`）→ 可识别"已被 WebUI 归档"的会话。
- 【源码明写】`ctx.agents.get(id): Agent | undefined`（`dsh-agent/lib/types/index.d.ts:341`）→ **拿同一进程内的 live agent，是"双向接管"的关键：WebUI 已加载的会话可直接复用其实例，无需二次 resume 抢锁**。
- 【源码明写】`ctx.agents.list(): Agent[]`（`:355`）、`ctx.agents.resume(options)`（`:287`，加载持久化会话）、`ctx.agents.create(options)`（`:279`）。
- 【源码明写】设置面板注册：`settings.installSection(owner, ns, schema, entry, hooks)`（`dsh-settings/lib/types/index.d.ts:228`）。

### 4.3 可参考的既有实现（napcat，已对齐 0.1.5）

napcat 在会话寻址与并发上已经把坑踩平，属**协议无关**部分，直接借鉴：
`SessionManager` 的 peersessionId 映射 / round-version 版本化 / 归档检测 / 物理存在探测 / 退避重试不抢锁；
`utils/path.ts` 的 `encodeSegment` V3 目录编码；`PerPeerSerialSender` 串行队列；
`filterAndExtractOutboundBlocks` 正文过滤；turn 级回复锚点绑定；设置卡片整套；`boot.ts` 装配助手。

> 注意：napcat 的**协议层**（OneBot 反向 WS、CQ 码、`reply`/`at` 段、QQ 号做 ID、`message_id` 当整数主键、WSL↔Windows 路径翻译）在本项目**全部不适用**，须整段重写。

---

## 5. QQ 官方 Bot API v2 协议基线（已核实）

### 5.1 接入与鉴权

- 【文档明写】`POST https://bots.qq.com/app/getAppAccessToken`，body `{ appId, clientSecret }`；请求头 `Authorization: QQBot <access_token>`。
  参考实现 `nyagent/src/plugins/qq-gateway/client.ts`（token singleflight + 提前 60s 刷新，可复用）。
- 【文档明写】`GET https://api.sgroup.qq.com/gateway` 取 WS 地址；intent `GROUP_AND_C2C_EVENT = 1<<25`。
- 【文档明写】单聊事件名 `C2C_MESSAGE_CREATE`，intent `GROUP_AND_C2C_EVENT (1<<25)`。
  [单聊消息事件](https://bot.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)

### 5.2 被动回复与额度（⚠️ 含一处已更正的结论）

- 【文档明写】被动消息 **单聊 60 分钟有效 / 每条消息最多回复 4 次**；群聊 5 分钟 / 5 次。
  [消息收发概述](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- 【文档明写】额度的计数单位是 **`(msg_id, msg_seq)` 组合**，不是 HTTP 请求次数：
  「相同的 `msg_id` + `msg_seq` 重复发送会失败，**可递增 `msg_seq` 实现对同一消息的多次回复**」（同上）；
  单聊接口字段说明与错误码 `40034128 被动回复时间或次数超限`、`40054005 消息被去重——请确保每次请求使用不同的 msgseq 值`
  （[发送单聊消息](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)）。
- 【文档明写】单聊 `/messages` 接口频率限制 **100 QPS，包括主动、被动等所有消息类型**（同上）。
- 【文档明写】**流式接口文档通篇没有任何"回复次数/额度"表述**，其错误码只有 `40007`（前缀不可改）/`50001`/`50002`（限频），
  **不含 `40034128`**；三个示例（首片/续片/结束片）的 **`msg_seq` 恒为 1**，靠 `index` 0/1/2 递增区分分片；接口 50 QPS。
  [流式发送单聊消息](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- 【推断】"一段流式只占 1 次回复额度"——**由文档推导，未被官方明写**。
- 【实测】**该 4 次上限当前并未被强制执行**：同一条 `msg_id` 连发 `msg_seq` 1–6 全部成功，用户手机确认收到 6 条（探针 E1）。
- 【实测】**流式占用 `(msg_id, msg_seq)` 槽位**：两段流式分别用掉 `msg_seq=1`/`2` 后，同 `msg_id` 的普通消息 `seq=1`/`2` 被拒 `40054005 消息被去重`（探针 E2）。
-  **更正记录**：方向讨论阶段曾把上面这条【推断】当作事实陈述（"一次流式回复只花 1 个回复位"），
  经用户要求"先问是不是"，已更正为【推断】。**用户实测结论：其另一个 bot 全部走普通消息、从未触发限额，原因是它"一条入站消息只回一条"，从不产生第 5 次回复。**
  据此用户拍板 **D9：代码不做额度防御逻辑**。
  **后由 E1 实测确认**：连发 6 次全部成功，该上限当前确实未生效（见 `docs/调研纪要-第一期探针结论.md` §E1）。

### 5.3 流式消息接口形状

- 【文档明写】`POST /v2/users/{user_openid}/stream_messages`
  字段：`input_mode`（`append` 默认 / `replace`，replace 时 `ContentRaw` 须以上游已下发前缀 `SentContent` 开头）、
  `input_state`（`1`=生成中，`10`=生成结束）、`index`（分片序号，从 0 递增）、`content_type`（`text`/`markdown`）、
  `content_raw`、`msg_id` 或 `event_id`、`stream_msg_id`（**第一条由服务端生成并返回，后续分片必须携带**）、
  `msg_seq`（去重）、`is_wakeup`。
  响应：`id`（首片即 `stream_msg_id`）、`timestamp`、`ext_info.ref_idx`、**`remain_msg_len`（流式消息剩余长度，字符数）**。
  错误码：`40007 已下发内容前缀不可修改`、`50001`、`50002`。（同上链接）

> ⚠️ **【实测】分片序号必须自维护（E11 结论 E11-6）**：DSH `agent/assistant-stream` 的 `chunk.index`
> 是 **per-attempt** 语义（每次 attempt 从 0 重新开始），**不可**直接透传给 QQ 的 `index` 字段，
> 否则每个 step 边界都会出现分片序号回退。本项目必须维护**跨 attempt 的全局分片计数器**。
> 证据：`docs/调研纪要-第一期探针结论.md` §E11（产物 `logs/probe/E11-assistant-stream-*.jsonl`）。
>
> **【实测】流式模式与槽位（探针 E2）**：
> - `append`（默认，只发增量）与 `replace`（累积全文，**必须以上次已下发内容为前缀**）**都可用**，
>   客户端表现均为**同一条消息原地增长**，且**首片即时可见**（无需等 `input_state=10`）；
> - **一段流式占用 `(msg_id, msg_seq)` 的一个槽位**：用掉 `msg_seq=N` 后，同一 `msg_id` 的普通消息不能再用 `N`（`40054005 消息被去重`）；
> - `remain_msg_len` 在 8 片 / 696 字符下**恒为 0**，**不可作为长度预算依据**；
> - `replace` 若前缀被改动即拒 `40007 已经提交的消息内容不可修改`（首轮探针踩到，已修正为纯追加）。

### 5.4 消息类型、Markdown 与富媒体

- 【文档明写】发送侧 `msg_type`：`0` 文本(`content`) / `2` Markdown(`markdown`) / `6` 输入中状态(`input_notify`) / `7` 富媒体(`media`)。
  单聊 `input_notify: { input_type: 1, input_second: ≤60 }`。**「传了 markdown 后 `content` 必须为空」**
  （[发送单聊消息](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)）
  → ⚠️ nyagent 每处 `msg_type=2` 都同时下发 `content` 与 `markdown.content`。
  **【实测】更正（探针 E4）**：文档的"必须为空"**并非硬约束**——同时下发两者**发送成功**，平台静默忽略 `content` 并渲染 `markdown`；
  真正会硬失败的是**反向**：`msg_type=2` 不带 `markdown` 字段 → `40034011 无效 markdown content`。
  新项目仍只发 `markdown.content`，但理由由"否则会失败"降级为"避免冗余字段"。
- 【文档明写】Markdown 子集（[Markdown 消息](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)）：
  支持标题 / `**加粗**` / `__下划线加粗__` / `_斜体_` / `*斜体*` / `***加粗斜体***` / `~~删除线~~` / 链接 /
  图片（**必须公网 URL**，平台下载转存）/ 有序列表 / 无序列表 / 列表嵌套 / 块引用 / 水平分割线 / 换多行（`\u200B`）。
- 【文档明写】**2026/04/23 能力更新**：单聊、群聊场景自定义 Markdown **已开放到所有机器人，无需单独申请模板**（同上）。
- 【实测】更正（探针 E5）：文档**未列出**的**表格、围栏代码块、行内代码、四级标题全部正常渲染**；
  2200 字符单条消息也未被拒。→ **markdown 适配层不需要做这些语法的降级转换**（推翻原"必须降级"预设）。
- 【实测】（探针 E5B）**markdown 图片可用**（腾讯 COS / 百度 logo 均正常显示）；
  但图片要求**公网可访问 URL**，本地图片仍须走 `msg_type=7` 分片上传。
- 【文档明写】富媒体：图片/视频/语音/文件需先上传得 `file_info`，再 `msg_type=7` + `media.file_info`。
  上传两条路：**分片上传（推荐）** / 整文件上传；**单聊与群聊上传接口不互通**；`file_info` 有 `ttl`，过期需重传。
  （[消息收发概述](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)）
- 【文档明写】历史版富媒体文档：整文件上传 body 为 `file_type / url / srv_send_msg / file_name / upload_id`，
  **`file_data` 标注"暂未支持"**；`file_type`：1 图片(png/jpg)、2 视频(mp4)、3 语音(silk)、4 文件(**暂不开放**)；
  `srv_send_msg=true` 会直接发送且占用主动频次。
  → ⚠️ nyagent 的 `QQBotClient.uploadFile` 以 `file_data: base64` **发送本地字节，协议层不成立**；新项目必须走分片上传。
- 【文档明写】分片上传流程：`upload_prepare`（返回 `upload_id` + 分片预签名 URL + `block_size`）→ 逐片 `PUT` 预签名 URL →
  `upload_part_finish` → 全部分片完成后带 `upload_id` 调 `/v2/users/{user_openid}/files` 换取 `file_info`。
  （官方文档：群聊富媒体预上传 / 单聊分片上传完成 等 autogen 页面）

### 5.5 身份与安全（用户拍板：不自研鉴权）

- 【文档明写】单聊事件 `author` 含 `id` / `user_openid` / `union_openid` / `username` / `bot`；
  附件 `attachments[]` 含 `url` / `filename` / `width` / `height` / `size` / `content_type`
  （`voice` | `image/jpeg` | `image/png` | `image/gif` | `video/mp4` | `file`）/ `voice_wav_url` / `asr_refer_text`；
  `message_scene.ext[]` 含 `msg_idx=...`、`ref_msg_idx=...`、`auth_token=...`（key=value 字符串列表）。
  [单聊消息事件](https://bot.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
- 【文档明写】错误码 `40054004 无好友关系——请先添加好友后再发送私信`
  （[发送单聊消息](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)）
  → **平台层强制好友关系**，且 openid 由平台颁发不可伪造。
- 【已陈述事实，非设计选项】平台不区分"哪一个好友"：凡与机器人建立好友关系的账号均可发消息。用户已拍板不自研鉴权层，本条仅作风险陈述。

### 5.6 其他已核实细节

- 【文档明写】引用回复 `message_reference: { message_id }`，值形如 `REFIDX_xxxxxx`；非机器人消息从 `message_scene.ext` 的 `msg_idx` 取，
  机器人自己发的从发消息响应 `ext_info.ref_idx` 取。（同上）
  **【实测】E10 已确认：单聊引用可用**，两种取值来源（入站 `msg_idx` / 自己响应的 `ref_idx`）都能正常以引用形式显示。
- 【文档明写】单聊 `message_type`：`0` 普通文本 / `3` 结构化卡片(`ark_data`) / `101` 并行消息 / `102` 聊天记录 / `103` 引用消息(`msg_elements`)。
- 【文档明写】撤回：发送超过 **2 分钟**不可撤回。
- 【实测】更正（探针 E6）：**单聊未受 URL 白名单限制**——markdown 链接、裸 URL、markdown 图片三条全部成功，
  无 `40054010`，且链接在客户端可点击。→ **无需在适配层剥离链接**。
  （群聊错误码表列有 `40054010`，单聊表未列；实测印证单聊不适用。）

---

## 6. 架构分层（✅ 2026-09-15 用户确认）

```
src/
  index.ts              apply/inject + 设置卡片注册 + 装配接线（唯一入口）
  boot.ts               bootDshQqbotBridge —— 仅供测试/CI 的真实 DSH 装配助手
  constants/            端点、intents、msg_type、媒体限制、超时
  config/schema.ts      插件配置 schema（AppID/Secret/默认工作区/流式开关…）
  qq/
    client.ts           token singleflight + WS 全生命周期 + REST（messages/stream_messages/分片上传）
    events.ts           WS 事件分发 → C2C_MESSAGE_CREATE 适配为内部入站事件
    stream.ts           StreamSession（节流/前缀一致/回退）+ 与 DSH 流源的桥接
    markdown.ts         QQ markdown 子集适配层（表格/代码块降级、长度预算、链接策略）
    media-in.ts         入站附件下载落盘 + 模型注入载荷
    media-out.ts        出站分片上传 + file_info TTL 缓存 + msg_type=7 发送
    format.ts           msg_type=0/2/6 消息组装（含 content/markdown 互斥约束）
  dsh/
    workspaces.ts       工作区/会话枚举与归档识别（workspaceRegistry + agents）
    control.ts          控制目标指针 + 接管/新建/切换 + steer/followup + 忙闲判定
    addressing.ts       peer↔sessionId 编解码、V3 encodeSegment、物理存在探测（借鉴 napcat）
  commands/
    parse.ts            自研斜杠命令解析（两字中文命令，不接 ctx.commands）
    dispatch.ts         命令分发与权限外的错误回执
    state-machine.ts    入站状态机：审批 → 提问 → 分页 → 命令 → 未选中检查 → agent
    paging.ts           列表分页状态（listKind ∈ {sessions, workspaces}，跨页连续编号，无超时）
    target-store.ts     控制目标 + 工作区作用域的持久化记录
  outbound/
    queue.ts            PerPeerSerialSender（借鉴 napcat）
    anchors.ts          turn 级回复锚点绑定（借鉴 napcat）
  inbound/
    pipeline.ts         入站管线：命令 → 控制目标 → 附件 → 转发/steer
  tools/                send_file / send_image（agent 工具注册）
  client/               WebUI 设置卡片
```

**关键约束**：`src/index.ts` 禁止写成 napcat 那样的超千行单体（napcat 的 `onMessage` 单函数混合了 8 类职责，是明确的历史包袱）——入站处理必须落在 `inbound/pipeline.ts` 的分阶段函数里。

---

## 7. 复用映射表（强制维护 · AGENTS.md §2.4）

> **规则**：写任何新实现前先查下表；已有实现 **copy 过来适配**，禁止重写。
> 本表随实现推进持续补全，每个复用点必须记录 `源文件:行号 → 目标文件 → 适配动作`。
> 参考项目根目录：`~/dsh-napcat-bridge`（**首选**，已对齐 DSH 0.1.5）、`~/nyagent`（唯一走 QQ 官方 Bot API）。

### 7.1 来自 dsh-napcat-bridge（协议无关，首选参考）

| # | 复用点 | 源（file:line） | 目标 | 适配动作 |
|---|---|---|---|---|
| N1 | DSH 真实装配助手 | `src/boot.ts:49-162` | `src/boot.ts` | 改名 `bootDshQqbotBridge`；profile 名 `napcat-test`→`qqbot-test`；插件名与配置类型替换 |
| N2 | 插件装配形态 | `cordis.patch.yml:1-4`、`package.json:23-38` | 同名文件 | 替换插件 id/name；`dsh.client.inject` 清单按本项目客户端依赖调整 |
| N3 | 客户端 bundle 打包 | `scripts/build-client.ts` | 同名文件 | 替换产物 id 与入口 |
| N4 | V3 路径编码 | `src/utils/path.ts:25-37` | `src/dsh/addressing.ts` | 直接搬（已有契约测试对齐）；**只搬编码函数，不搬 WSL 路径翻译** |
| N5 | 会话寻址/版本化/归档探测 | `src/gateway/session.ts:72-98, 433-670` | `src/dsh/addressing.ts` + `src/dsh/workspaces.ts` | 保留寻址与归档判定；**换成 `workspaceRegistry` 枚举语义**（本项目接管已有会话，不再自造 peer 会话） |
| N6 | resume 锁冲突不抢占 | `src/gateway/session.ts:1078-1121` | `src/dsh/control.ts` | 保留"锁冲突抛错、**绝不降级新建**"与"不抢占在途回合"；**按 E12-B 实测取消退避重试**（改立即如实回执）；**删除 monkey patch 与 `as any` 兜底**（D30） |
| N7 | per-peer 串行队列 | `src/outbound/queue.ts:16-37` | `src/outbound/queue.ts` | 直接搬；"peer" 语义改为一对一单聊 openid |
| N8 | 正文块过滤 | `src/outbound/stream.ts:21-44` | `src/qq/stream.ts` | 直接搬（只留 text 块、剥 reasoning/tool-call/tool-result） |
| N9 | turn 级回复锚点绑定 | `src/outbound/stream.ts:224-335` | `src/outbound/anchors.ts` | 保留 turn 绑定与"首段带前缀"；前缀语义由 CQ 引用/@ 改为官方被动回复（`msg_id`/`msg_seq`） |
| N10 | 设置面板（服务端 + 客户端） | `src/index.ts:79-115`；`src/client/index.tsx:19-183, 350-359`；`card.tsx`/`fields.tsx`/`model.ts`/`card-styles.ts` | `src/index.ts` + `src/client/*` | 保留整套机制与 CONFLICT 重试；字段换为本项目配置（AppID/Secret/默认工作区/流式开关） |
| N11 | per-peer 消息等待收集器 | `src/gateway/server.ts:534-624` | — | **暂不搬**：本项目无 `wait_for_user_messages` 需求（D8 范围红线） |
| N12 | SQLite 消息库 schema | `src/storage/database.ts:149-188, 240-447` | — | **暂不搬**：本项目是否需要消息落库尚未拍板，不得擅自引入 |
| N13 | 媒体 TTL 清理 | `src/storage/media.ts` | `src/qq/media-out.ts`（TTL 部分） | 只搬 `file_info` TTL 缓存语义；文件下载链路不适用 |
| N14 | 上下文用量取值 | `src/commands/index.ts:871-966` | `src/commands/dispatch.ts` | 照抄取值与降级逻辑（D32）；**不照抄 `ctx.get('x') \|\| (ctx as any).x` 兜底** |

### 7.2 来自 nyagent（QQ 官方协议侧）

| # | 复用点 | 源（file:line） | 目标 | 适配动作 |
|---|---|---|---|---|
| Y1 | 官方 Bot 客户端 | `src/plugins/qq-gateway/client.ts` 整体 | `src/qq/client.ts` | 保留 token singleflight/提前 60s 刷新、WS 全生命周期、退避重连、"HTTP 200 但 `body.code!==0` 视为错误"；**补**：401 后强制刷新重试、HELLO 看门狗、**分片上传**接口替换 `uploadFile` |
| Y2 | 流式消息状态机 | `src/plugins/qq-gateway/stream.ts:24-201`（`StreamSession`） | `src/qq/stream.ts` | 保留节流/`index`/`input_state`/`stream_msg_id` 流转与失败回退；**事件源换成 `agent/assistant-stream`**（原 `assistant/chunk` 已失效）；`msg_seq` 逐片自增需按探针 E2 结论修正 |
| Y3 | markdown 最小修补 | `src/plugins/qq-gateway/stream.ts:19-22`（`formatQQMarkdown`） | `src/qq/markdown.ts` | 作为适配层**起点**，再按探针 E5 结论扩展表格/代码块降级与长度预算 |
| Y4 | 入站附件下载 | `src/plugins/qq-gateway/media.ts:185-363` | `src/qq/media-in.ts` | 保留 SSRF 守卫 + 流式限流 + 文件名净化 + 图片 data URL 注入；**补** `attachments[].url` 的 `auth_token` 处理（探针 E8） |
| Y5 | 出站富媒体 | `src/plugins/qq-gateway/media-sender.ts` | `src/qq/media-out.ts` | 保留 `file_type` 映射、软/硬限降级、TTL 缓存（-60s 边界）、指数退避、文本兜底；**上传协议改为分片上传** |
| Y6 | secret 四级解析 | `src/plugins/qq-gateway/diagnosis.ts:69-89` | `src/config/credentials.ts` | 保留解析顺序；按 D17 键名改为 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` |
| Y7 | 入站分发骨架 | `src/plugins/qq-gateway/message-handler.ts` | `src/inbound/pipeline.ts` | 保留"审批→提问→命令→agent"骨架与"错误绝不吞、回执截断"；**插入本项目新增的"分页→未选中检查"两层**（设计文档 §4） |
| Y8 | 远端审批/提问交互模式 | `src/plugins/qq-gateway/approval.ts`、`questions.ts` | `src/inbound/*`（按需） | 保留 300s fail-closed、单 openid pending、旧请求 supersede、AbortSignal 联动；**类型改为 import 真实 `.d.ts`**；**去掉兜底 `'default'` openid** |
| Y9 | QQ 常量表 | `src/constants/index.ts` | `src/constants/index.ts` | 搬端点/intents/msg_type/超时；**剔除额度防御常量与 `~/.nyagent` 路径** |
| Y10 | 配置 schema | `src/config/schema.ts`（qq-gateway 部分） | `src/config/schema.ts` | 只保留连接与行为字段；**删除 memory/timezone/curator/learn 命名空间** |
| Y11 | i18n 组织方式 | `src/i18n/zh-CN.ts` | `src/i18n/*`（按需） | 只借"功能域.对象.字段"两层的组织方式；文案全部新写（命令集已变） |

### 7.3 必须重写（不可复用，逐条列明理由）

| # | 不复用对象 | 理由（AGENTS.md §2.4 例外条款） |
|---|---|---|
| X1 | nyagent 的 `assistant/chunk` 流式源 | **已证实失效**：DSH v2 无该事件，整条链路从不触发 |
| X2 | nyagent 的 `content` + `markdown` 同时下发 | **违反官方约束**：「传了 markdown 后 content 必须为空」 |
| X3 | nyagent 的 `uploadFile`（`file_data` base64） | **违反官方契约**：该接口无 `file_data` 字段，本地字节须走分片上传 |
| X4 | nyagent 的 `qq-<openid>-<n>` 会话创建模型 | 与本项目"接管 WebUI 已有会话"的模型根本冲突（D3/D5） |
| X5 | napcat 的 OneBot 协议层全套（反向 WS、post_type、echo、action、CQ 码、reply/at、notice） | **协议不兼容** |
| X6 | napcat 的 QQ 号做 ID / bot_qq 自循环防护 / message_id 当整数主键 | 官方是 openid 与字符串 id，ID 与权限模型不同 |
| X7 | napcat 的 Windows/WSL 路径翻译链路 | 官方走 URL/分片上传，无本地路径概念 |
| X8 | 两个旧项目的"每个 peer 新建会话"语义 | 与 D3/D5 冲突 |
| X9 | 额度防御分支 | D9：用户实测结论，禁止未经验证的防御逻辑 |
| X10 | 两处 monkey patch / `as any` 兜底 / 死代码 | AGENTS.md §2.4「去债不去功能」表 |

### 7.4 复用落地记录（P2 实施结果 · 由 Lead 持续维护）

> AGENTS.md §2.4 要求「复用映射表必须落盘并持续维护」。§7.1/7.2 是**计划**，本表是**实际落地结果**。

| 映射 | 源 | 实际落地 | 适配动作（实际执行的） |
|---|---|---|---|
| N1 | `dsh-napcat-bridge/src/boot.ts:49-162` | `src/boot.ts` | 改名 `bootDshQqbotBridge`、profile `napcat-test`→`qqbot-test`、插件挂载改按需动态导入 |
| N2/N3 | napcat `cordis.patch.yml` / `package.json` dsh 字段 / `scripts/build-client.ts` | 同名文件 | 替换插件 id/name；补 `dsh.client.inject` 四项；`build` 改为 `tsc && pnpm run build:client`（原指向不存在的 .js，由 client-ui 上报） |
| N4 | napcat `src/utils/path.ts:25-36` | `src/utils/path.ts` + `src/dsh/addressing.ts` | 逐字复用 `encodeSegment`；**未搬** WSL 路径翻译 |
| N5 | napcat `src/gateway/session.ts:72-98,433-670` | `src/dsh/{workspaces,addressing}.ts` | 保留存在性/归档探测思路；**换成 `workspaceRegistry` 枚举语义**（接管已有会话） |
| N6 | napcat `src/gateway/session.ts:1078-1121` | `src/dsh/control.ts` | 保留"锁冲突抛错、绝不降级新建、不抢占在途回合"；**按 E12-B 实测取消退避重试**；删除 monkey patch 与 `as any` 兜底 |
| N7 | napcat `src/outbound/queue.ts:16-37` | `src/outbound/queue.ts` | 直接搬 `PerPeerSerialSender` |
| N8 | napcat `src/outbound/stream.ts:21-44` | `src/outbound/turn-router.ts` | 保留"只留 text 块"的过滤哲学；**事件源换成 `agent/assistant-stream`**（E11 实测 napcat 用的会话事件不含 chunk） |
| N9 | napcat `src/outbound/stream.ts:224-335` | `src/dsh/anchors.ts` + `src/index.ts` | turn 级锚点绑定落地；前缀语义由 CQ 引用/@ 改为官方 `message_reference`（E10 实测可用） |
| N10 | napcat `src/client/*` | `src/client/*` | 整套机制与 CONFLICT 重试保留；字段换 `PluginConfig`；删 persona/proactive/memory/review 与 `QQComposerHider`；CSS 前缀 `napcat_`→`qqbot_` |
| N13 | napcat `src/storage/media.ts`（TTL 语义） | `src/qq/media-out.ts` | 只搬 `file_info` TTL 缓存（expiresAt = ttl − 60s） |
| N14 | napcat `src/commands/index.ts:871-966` | `src/index.ts`（models 门面） | 取值逻辑照抄，**去掉 `as any` 兜底**，改经 `ctx.get` 判定 |
| Y1 | `nyagent/src/plugins/qq-gateway/client.ts` | `src/qq/client.ts` | 保留 token/WS/REST/「HTTP 200 但 code≠0 也算失败」；**补** 401 刷新重试、HELLO 看门狗、四步分片上传；**删** `uploadFile`（`file_data` 官方无此字段） |
| Y2 | nyagent `stream.ts:24-201` | `src/qq/stream.ts` | 保留节流/`input_state`/`stream_msg_id`/失败回退；**事件源换 `agent/assistant-stream`**；**删**逐片 `msg_seq` 自增 |
| Y3 | nyagent `stream.ts:19-22` | `src/qq/markdown.ts` | `formatQQMarkdown` 正则逐字复用；**未加**表格/代码块降级（E5 实测不需要） |
| Y4 | nyagent `media.ts:185-363` | `src/qq/media-in.ts` | 保留 SSRF 守卫 + 流式限流 + 文件名净化 + 图片 data URL；**补** `voice_wav_url`/`asr_refer_text`（E8） |
| Y5 | nyagent `media-sender.ts` | `src/qq/media-out.ts` | 保留 `file_type` 映射/软硬限降级/TTL/退避；**上传协议整体改为四步分片上传**（E7） |
| Y6 | nyagent `diagnosis.ts:69-89` | `src/config/credentials.ts` | 保留解析顺序，键名按 D17 改 `QQ_BOT_APP_ID`/`QQ_BOT_SECRET` |
| Y7 | nyagent `message-handler.ts` | `src/inbound/pipeline.ts` | 保留分发骨架与"错误绝不吞、回执截断"；**插入**分页与未选中检查两层 |
| Y8 | nyagent `approval.ts`/`questions.ts` | `src/inbound/interactions.ts` | 保留 300s fail-closed、单 openid pending、旧请求 supersede；**改为公开 waterfall 事件**（不用 provider 私有面） |
| N11/N12 | napcat 等待收集器 / SQLite 消息库 | — | **未搬**：本项目无 `wait_for_user_messages` 需求；消息落库尚未拍板（不擅自引入） |
| Y11 | nyagent `src/i18n/zh-CN.ts` + `src/i18n/index.ts` | `src/i18n/zh-CN.ts` + `src/i18n/index.ts` | 2026-09-17 落地（D51）：只借「功能域.对象.字段 + `{{参数}}`」组织方式；**文案全部新写**。适配：去掉 `locale` 参数与 `en-US` 表（本项目单语言，不留死代码）；键改为编译期字面量联合 `MessageKey`；键缺失**抛错**、参数缺失**保留 `{{name}}`**（不静默降级/不静默丢字） |

**必须重写项（X1–X10）的执行确认**：全部未复用，理由见 §7.3；`X2`（content+markdown 双下发）经 E4 实测**不是硬失败**，但仍按"只发 markdown"实现（卫生）。

---

## 8. 已知空白（需探针回答）

见 `docs/任务包-第一期真机探针与协议空白实测.md`，摘要：

| 编号 | 空白 | 影响面 | 状态 |
|---|---|---|---|
| E1 | 流入额度计数口径（同一 msg_id 递增 msg_seq 到第几次失败） | 是否需降级策略（当前 D9 判定：不做防御） |  待凭据 | | ✅ **已实测**：6/6 成功，4 次上限未生效 |
| E2 | 流式是否占用被动回复额度 | 同上 | ⏸ 待凭据 | | ✅ **已实测**：占用 (msg_id,msg_seq) 槽位；append/replace 均可用 |
| E3 | 流式长度预算（`remain_msg_len` 规律、超限行为） | markdown 适配层的分段策略 | ⏸ 待凭据 | | ️ **已实测（2026-09-16）**：**单次流式请求上限 ≈20 KiB 字节**（夹逼 ∈[20414,20426)，失败码 `40054018`）；**累积总量 ≥20000 字符无约束**（`remain_msg_len` 恒 0）；非流式单条 markdown ≥32000 字符（96 KB）未触限；详见 `docs/调研纪要-E3长度上限真机实测-2026-09-16.md` |
| E4 | `content`/`markdown` 互斥的真实报错边界 | 消息组装 |  待凭据 | | ✅ **已实测**：不硬失败；反向才报 40034011 |
| E5 | markdown 表格/代码块/行内码/嵌套的真实渲染与报错 | markdown 适配层 | ✅ **已实测**：表格/代码块/行内码全正常渲染，2200 字符未被拒 |
| E6 | 单聊是否受 URL 白名单限制（`40054010` 是否出现） | 链接策略（是否必须剥离链接） | ✅ **已实测**：单聊不受 URL 白名单限制，链接可点 |
| E7 | 分片上传全链路（prepare→PUT→part_finish→files→file_info→msg_type=7） | 出站文件/图片与工具 | ⏸ 待凭据 |
| E8 | 入站附件下载是否需 `auth_token`（`message_scene.ext`） | 入站文件落盘 | ⏸ 待凭据+用户 |
| E9 | `msg_type=6` 输入中状态是否占额度、时长上限 | 降级策略（D9） |  待凭据 | | ✅ **已实测**：服务端成功 + 客户端显示「正在输入」 |
| E10 | 单聊引用回复 `message_reference` 是否可用 | 回复锚定体验 | ⏸ 待凭据+肉眼 | | ✅ **已实测**：单聊引用可用 |
| E11 | DSH 侧 `agent/assistant-stream` 帧序列与 `text-delta` 边界（**无需 QQ 凭据，可立即做**） | 流式桥接的正确性 | ✅ **已实测** |
| E12 | **WebUI 与 QQ 同时驱动同一会话**（接管是否拿到同一 live agent、steer 是否命中正在跑的 turn、resume 排他锁的实际表现） | **R2 的核心假设**；决定 D30 能否直接落地 | ✅ **E12-A/B 已完成**（同进程全通；跨进程立即锁冲突）；真机端到端转 P2 |

---

## 9. 风险登记

| 编号 | 风险 | 级别 | 应对 |
|---|---|---|---|
| R1 | 额度口径判断错误（D9 决定不防御） | 中 | 探针 E1/E2 实测；若实测证明易撞限，再回来与用户确认降级策略 |
| R2 | 双向接管的会话排他锁与抢占 | **低**（E12-A 同进程三机制全通 → 主路径不触锁；E12-B 实测跨进程**立即** `SessionAlreadyOwnedError` → **"同进程"是硬约束**，已从架构上消除该风险） | 优先用 `ctx.agents.get(id)` 复用 live agent（同一进程内 WebUI 已加载的实例），避免二次 resume 抢锁；napcat 的"退避重试不抢占"策略作兜底；严禁 monkey patch `sessionController`（napcat 有两处猴补，是明确技术债） |
| R3 | markdown 子集不支持表格/代码块，而 Agent 输出大量含表格 | 中 | 适配层降级（表格→对齐文本、代码块→去围栏保缩进）；探针 E5 定形 |
| R4 | 长输出撞长度上限（`40054007` / `40054018` / 流式 `remain_msg_len`） | 中 | 适配层做分段与续发；探针 E3 → **2026-09-16 实测已定界**（单次请求 ≈20 KiB 字节），但 `MarkdownAdapter.split()` **至今零调用**：对冲措施未接线，且截断落在"整段累积"维度 ⇒ 单步 >4000 码点回复被静默切尾 |
| R5 | 分片上传链路复杂（prepare/PUT/finish）易碎 | 中 | 探针 E7 全链路实测后再实现；file_info 做 TTL 缓存 |
| R6 | DSH 内部 API 以 `as any` 兜底绑定 0.1.x 实现，升级即炸 | 中 | 显式声明 peerDependencies 与真实 `.d.ts` 类型；**禁止 `ctx.get() || (ctx as any).x` 式兜底**（napcat 的教训）；升级适配列为独立任务 |
| R7 | 接管范围过大导致误操作（steer 注入打乱正在跑的任务） | 中 | 命令侧给出明确回执（当前控制目标/忙闲状态）；D7 已定为 steer，需在回执上做足提示 |
| R8 | 直接透传 DSH 的 `chunk.index` 会导致 QQ 分片序号回退（每 step 归零） | 中 | 已由 E11-6 实测确认；实现时自维护全局分片计数器，并加契约测试断言跨 step 单调递增 |
| R9 | **`msg_seq` 槽位冲突**：流式已占用某 `msg_seq`，若审批/提问卡片复用同一格会被 `40054005` 去重拒绝 | **高** | 已由 E2 实测确认；须实现 **per-`msg_id` 的 `msg_seq` 槽位分配器**，流式先占格、其余消息取未占用格（见 `docs/设计方案-命令系统与远程控制状态机.md` §7.5） |

---

## 10. 决策收尾状态（全部已确认 · 2026-09-15）

| # | 事项 | 状态 |
|---|---|---|
| 1 | §6 架构分层（`src/index.ts` 只做接线、逻辑下沉子模块） | ✅ **用户已确认**（同日） |
| 2 | 命令集命名与语法 | ✅ 已拍板 → `docs/设计方案-命令系统与远程控制状态机.md` §3/§8（D18–D35） |
| 3 | 风险 R2 提前到探针阶段验证 | ✅ 已执行 → E12-A（同进程三机制全通）+ E12-B（跨进程立即锁冲突）；真机端到端转 P2 |
| 4 | 命令系统三个细节项（`/状态` 字段、列表信息、回执格式） | ✅ 已拍板 → 设计文档 §11（D32–D35） |
| 5 | §9-R7（steer 误操作提示强度） |  **待 P2 实现时随回执文案一并定**（不阻塞开工） |

### P2 启动状态

- **P1 探针主体已完成**：11 个实验结论归档于 `docs/调研纪要-第一期探针结论.md`；仅 E3（流式长度上限）为低优先补充项。
- **用户指示：暂停于此，审阅文档后再通知开工**。→ **P2 不得自行启动**。
- P2 的首批工作（按复用映射表 §7 执行，禁止重写）：
  1. 脚手架补齐：`src/index.ts`（仅接线）、`src/constants/`、`src/config/schema.ts`、`src/client/*`、`cordis.patch.yml` 接入；
  2. TDD 契约测试先行（先红），契约点见 `docs/设计方案-命令系统与远程控制状态机.md` §10 与本文 §9 风险项；
  3. 协议内核：`src/qq/client.ts` ← Y1、`src/qq/stream.ts` ← Y2 + E11 流源、`src/qq/markdown.ts` ← Y3 + E5 结论、`src/qq/media-*.ts` ← Y4/Y5 + E7/E8 结论；
  4. 三处**必须通过契约测试锁死**的实测语义：`msg_seq` 槽位分配（R9）、QQ 分片序号自维护（R8）、分片上传 1-based `index` 与每片 `block_size`（E7）。