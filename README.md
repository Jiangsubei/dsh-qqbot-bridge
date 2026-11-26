# dsh-qqbot-bridge

[![npm version](https://img.shields.io/npm/v/dsh-qqbot-bridge.svg)](https://www.npmjs.com/package/dsh-qqbot-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.0-4f46e5)](https://github.com/deepseek-ai/dsh)
[![QQ Bot API](https://img.shields.io/badge/QQ%20Bot%20API-v2%20C2C-00CAFC)](https://q.qq.com/)

DeepSeek Harness × QQ 官方机器人桥接插件 —— 用 **QQ 单聊（C2C）** 远程控制 DeepSeek Harness (DSH) 中已有的工作区与会话：整回合流式输出、Markdown 排版、交互式审批/提问卡片、双向文件/图片收发与中文斜杠命令系统。

> [!IMPORTANT]
> **范围与合规说明**
> - 全链路直连腾讯 **QQ 开放平台官方 Bot API v2**（正向 WebSocket + OpenAPI REST），不依赖第三方逆向协议端。
> - **仅支持单聊（C2C）**：不做群聊、频道与频道私信；不自研鉴权层，依赖 QQ 开放平台 `openid` 与好友关系。
> - **专注远程控制桥接**：不维护插件自有记忆、人格或模型副本，会话、工作区、模型与权限均直通 DSH 官方服务。

---

## ✨ 功能特性

- **远程接管 DSH 工作区与会话**：`/切换` 选择工作区、`/会话` 选择并接管会话；同进程优先复用 live agent，遇排他锁占用如实回执，绝不降级新建空白会话。
- **首次直发引导**：未选中会话时直接发送普通消息，自动在默认工作区（`$DSH_HOME/workspace/default`）新建会话并转发该消息（受 `allow_create_session` 控制）。
- **整回合正文流式下发**：监听 `agent/assistant-stream` 并仅放行 `text-delta`；按 step 独立流式输出，支持节流聚合、按 UTF-8 字节安全切分、流式失败降级普通 Markdown，以及被动回复超限/过期（`40034005` / `40034128`）自动降级主动消息重试。
- **审批与提问远程卡片交互**：基于 Cordis waterfall `{ prepend: true }` 拦截 `approval/request` 与 `user-questions/request`（仅接管 QQ 发起的受控回合，WebUI 回合互不干扰），发送 Markdown 卡片与内联按钮（失败自动降级纯 Markdown 引导，同时兼容文本应答）。
- **文件与图片双向收发**：为 Agent 注册 `send_file` / `send_image` 工具（四步分片上传 + `msg_type=7`）；入站支持图片（含文件头 magic bytes 修正扩展名与 MIME）、语音（含转写文本）、视频与文件落盘并注入会话上下文，内置 SSRF 防御。
- **中文命令与英文别名**：内置 10 个主命令与 `/下一页` / `/上一页` 分页子命令，兼容全角 `／` 前缀与常见英文别名，10 条/页跨页连续编号。
- **WebUI 四分区设置面板**：集成于 DSH 设置界面（连接 / 行为 / 文件 / 命令，共 11 项 `volatile` 热更新参数），支持 REST `app_secret` 脱敏保存与旧版 `settings.yaml` 静默迁移。

---

## 📦 快速安装

### 前置条件

- **Node.js** `>= 20.0.0` 与 **DeepSeek Harness (DSH)** `>= 0.2.0`（已针对 `0.2.2-rc.5` 完成编译与装配验证）
- 已在 [QQ 开放平台](https://q.qq.com/) 创建的 QQ 机器人（`AppID` / `AppSecret`），且测试账号已加机器人为好友

### 方式一：通过 DSH 插件管理安装（推荐）

```bash
# 推荐：安装到 DSH 的 web profile
dsh plugin --profile web add dsh-qqbot-bridge

# 或安装到全局默认环境
dsh plugin add dsh-qqbot-bridge
```

### 方式二：从源码克隆安装（本地开发 / link 模式）

```bash
git clone https://github.com/Jiangsubei/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
pnpm install
pnpm build
dsh plugin --profile web add link:.
```

> [!WARNING]
> 本地 `link:.` 开发模式下，每次修改 `src/` 后必须重新运行 `pnpm build` 生成 `dist/` 产物，否则 DSH 仍会加载旧代码。

---

## 🔑 凭据配置与启动

推荐通过 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）或环境变量托管凭据，避免明文写入插件配置文件：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  QQ_BOT_APP_ID: "<你的 AppID>"
  QQ_BOT_SECRET: "<你的 AppSecret>"
```

凭据解析优先级（高到低）：**环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` → `.credentials.yaml` 的 `refs` → WebUI 设置面板 `app_id` / `app_secret`**。

启动服务：

```bash
dsh --profile web   # 默认 WebUI 地址：http://127.0.0.1:3080/
```

无凭据时插件处于离线待机（仍可打开 WebUI 设置面板）；填写并保存凭据后自动热上线连接 QQ 网关。

---

## ⚙️ 配置项一览 (11 项)

| 分区 | 参数 | 默认值 | 说明 |
|---|---|---|---|
| 连接 | `app_id` | `""` | QQ 开放平台机器人 AppID（留空则读环境变量 / `.credentials.yaml`） |
| 连接 | `app_secret` | `""` | QQ 开放平台机器人 AppSecret（建议留空，走 `.credentials.yaml`） |
| 连接 | `default_workspace` | `""` | 默认工作区路径；留空使用 `$DSH_HOME/workspace/default` |
| 行为 | `stream_enabled` | `true` | 是否启用 QQ 流式消息输出（关闭则使用普通 Markdown 消息） |
| 行为 | `stream_throttle_ms` | `1000` | 流式分片最小节流间隔（毫秒） |
| 行为 | `allow_create_session` | `true` | 是否允许 QQ 侧新建会话（`/新建` 与未选中直发自动新建） |
| 文件 | `media_dir` | `"qqbot/media"` | 入站附件落盘目录（相对 `$DSH_HOME`，或写绝对路径） |
| 文件 | `media_max_bytes` | `209715200` | 单个入站附件落盘上限（字节，默认 200 MiB） |
| 命令 | `reply_max_chars` | `1500` | 命令回执纯文本最大字符数（超出截断） |
| 命令 | `list_page_size` | `10` | `/会话` 与 `/切换` 列表每页条数 |
| 命令 | `status_show_usage` | `true` | `/状态` 是否显示上下文用量 |

---

## 💬 斜杠命令与远端交互

| 命令 | 英文别名 | 说明 |
|---|---|---|
| `/会话 [序号\|标题]` | `/sessions`, `/ls` | 列出 / 切换当前工作区会话（可见性与 WebUI 侧边栏一致） |
| `/切换 [工作区]` | `/switch`, `/ws` | 列出 / 切换工作区作用域（切换会清空当前控制目标） |
| `/新建 [路径]` | `/new`, `/reset`, `/clear` | 在当前（或指定）工作区新建会话，未注册路径自动建目录并注册 |
| `/停止` | `/stop`, `/abort` | 中断当前受控会话正在生成的回复 |
| `/状态` | `/status` | 查看目标、工作区、模型、思考强度、权限档位、忙闲状态与上下文用量 |
| `/压缩` | `/compact` | 压缩当前会话历史（不可中断，完成后追加结果） |
| `/模型 [名称]` | `/model` | 查看 / 切换模型（支持 `<provider>/<model>`） |
| `/思考 [档位]` | `/thinking`, `/think` | 查看 / 切换思考强度 |
| `/权限 [档位]` | `/permission`, `/perm` | 查看 / 切换权限预设（`只读` / `编辑` / `完全`） |
| `/帮助` | `/help` | 查看命令帮助 |
| `/下一页` `/上一页` | `/next`, `/prev` | 列表翻页（跨页连续编号，超过 1 页时由页脚提示） |

- **审批**：支持点击卡片「允许一次 / 拒绝」按钮，或回复 `y`（`是`/`允许`/`同意`/`批准`/`1`/`好`/`可以`）、`n`（`否`/`拒绝`/`2`/`不`）、`/取消`；超时 300 秒自动拒绝。
- **提问**：单选题支持点击 2 列内联按钮，也可回复序号（多选用逗号如 `1,3`）、自定义文本、`/跳过` 或 `/取消`；超时 300 秒视为未作答。

---

## 🛠️ 开发与测试

```bash
pnpm install
pnpm build           # tsc + 客户端设置面板构建（dist/client.js）
pnpm typecheck       # 源码类型检查
pnpm typecheck:all   # 含测试在内的全量类型检查
pnpm check:privacy   # 隐私守卫扫描（确保无真实凭据/身份 ID 入库）
pnpm test:quick      # 仅运行 Vitest 契约测试
pnpm test            # 完整 build + Vitest 契约测试
```

---

## 📚 文档索引

- [文档中心索引 (docs/README.md)](docs/README.md)
- [快速上手指南 (docs/getting-started.md)](docs/getting-started.md)
- [运行时配置参考 (docs/configuration.md)](docs/configuration.md)
- [命令系统、远端交互与工具手册 (docs/commands-and-interactions.md)](docs/commands-and-interactions.md)
- [系统架构与实现机制 (docs/architecture.md)](docs/architecture.md)
- [常见问题排查与协议边界 (docs/troubleshooting.md)](docs/troubleshooting.md)
- [开发日志与实测归档 (devlog/README.md)](devlog/README.md)

---

## 📄 License

[MIT](LICENSE)
