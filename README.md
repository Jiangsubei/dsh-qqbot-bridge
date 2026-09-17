# dsh-qqbot-bridge

[![npm version](https://img.shields.io/npm/v/dsh-qqbot-bridge.svg)](https://www.npmjs.com/package/dsh-qqbot-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DeepSeek Harness × QQ 官方机器人插件 —— 用 **QQ 单聊**远程控制 DSH 里已有的所有工作区会话：流式输出、Markdown 渲染、文件收发、命令系统。

走 QQ 开放平台官方 **Bot API v2**，身份即 openid 与好友关系，不自研鉴权层；**仅单聊 C2C**，不做群聊/频道。

## ✨ 功能特性

- **远程控制 DSH 已有会话**：`/切换` 选工作区、`/会话` 选会话，直接驱动 DSH 里已存在的会话
- **全工作区覆盖**：WebUI 里能看到的工作区与会话，QQ 侧都能列出来接管
- **首次直发引导**：装好插件后不做任何选择、直接发一条消息 → 自动在**默认工作区** `$DSH_HOME/workspace/default` 建会话并处理该消息（不会落到用户主目录）
- **整回合正文流式输出**：每个 step 的正文单独一条，不拼接、不丢步
- **Markdown 渲染**：标题/表格/代码块/行内代码/图片均按 QQ 原生 Markdown 渲染
- **文件与图片收发**：Agent 可调 `send_file` / `send_image` 工具发回；入站附件自动落盘并注入会话
- **审批与提问可远程作答**：`approval/request` / `user-questions/request` 转发到 QQ，回复即可决策（超时 300s fail-closed）
- **命令系统**：9 个中文命令 + 翻页子命令，回执纯文本；10 条/页、跨页连续编号
- **与 WebUI 同进程、状态实时同步**：插件建的会话会实时出现在 WebUI 侧边栏所属工作区分组里
- **接管不抢锁、绝不降级**：优先复用 live agent；遇排他锁冲突立即如实回执
- **WebUI 设置卡片**：连接 / 行为 / 文件 / 命令 四个分区；AppID/Secret 支持从 DSH 凭据库读取

**明确不做**：群聊 / 频道 / 频道私信、记忆与人格、主动回复、表情回应、会话归档与删除、自研鉴权。

## 📦 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh)：`npm install -g @deepseek-ai/dsh`
- Node.js ≥ 20 与 [pnpm](https://pnpm.io/)
- 一个 QQ 开放平台机器人（AppID / AppSecret），以及一个能与该机器人单聊的 QQ 号

### 安装方式

#### 方式一：通过 DSH 插件管理一键安装（推荐）

```bash
# 推荐：安装到 DSH 的 web profile（无需编译，秒级安装）
dsh plugin --profile web add dsh-qqbot-bridge

# 或安装到全局默认环境
dsh plugin add dsh-qqbot-bridge
```

#### 方式二：从源码克隆安装（本地开发 / link 模式）

```bash
git clone https://github.com/Jiangsubei/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
pnpm install
# 构建产物：DSH 通过 package.json main → dist/ 加载，必须先 build
pnpm build
# link 安装到 DSH 的 web profile
dsh plugin --profile web add link:.
```

### 配置凭据

推荐写进 DSH 凭据库（与 DSH 其他密钥同一处，不落 `settings.yaml`）：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  QQ_BOT_APP_ID: "<你的 AppID>"
  QQ_BOT_SECRET: "<你的 AppSecret>"
```

也可以在 WebUI 设置卡片直接填 `app_id` / `app_secret`。解析优先级（前者优先）：
**环境变量 `QQ_BOT_APP_ID`/`QQ_BOT_SECRET` → `.credentials.yaml` 的 `refs` → 插件配置**。

### 启动

```bash
dsh --profile web          # WebUI 在 127.0.0.1:3080
```

启动后从 QQ 给机器人发一条消息即可。机器人是**被动回复**模型：必须先由用户侧发起单聊。

> ⚠️ **改了 `src/` 必须重新 `pnpm build`**：link 部署时 DSH 加载的是 `dist/`。只改源码不构建，插件仍跑旧代码。

## 🚀 首次使用

1. **直接发消息**：不做任何选择就发一条消息，插件会自动新建会话（回执只报工作区名），这条消息就是该会话的第一个 prompt。
2. **选工作区**：`/切换` 列出所有工作区 → `/切换 <序号或名字>` 选中（**会清空当前控制目标，防误发**）。
3. **选会话**：`/会话` 列出该工作区会话 → `/会话 <序号>` 接管，之后发消息就是在那个会话里说话。

一个 openid 同时只有一个控制目标；换会话用 `/会话`，换工作区用 `/切换`。

## ⚙️ 配置

| 参数                   | 说明                                                         | 默认值                |
| ---------------------- | ------------------------------------------------------------ | --------------------- |
| `app_id`               | QQ 机器人 AppID（留空则从环境变量 / `refs.QQ_BOT_APP_ID` 读取） | `''`                  |
| `app_secret`           | QQ 机器人 AppSecret（**建议留空**，走 `refs.QQ_BOT_SECRET`） | `''`                  |
| `default_workspace`    | 默认工作区路径；留空则用 `$DSH_HOME/workspace/default`（首次用到时自动创建并注册） | `''`                  |
| `stream_enabled`       | 整回合正文走 QQ 流式消息（关闭则用普通 Markdown 消息）       | `true`                |
| `stream_throttle_ms`   | 流式分片节流间隔（毫秒）                                     | `1000`                |
| `allow_create_session` | 允许 QQ 侧新建会话（管住 `/新建` 与「未选中态直接发消息」的自动新建） | `true`                |
| `media_dir`            | 入站附件落盘目录（相对 `$DSH_HOME`；也可写绝对路径）         | `qqbot/media`         |
| `media_max_bytes`      | 单个入站附件落盘上限（字节）                                 | `209715200`（200 MB） |
| `reply_max_chars`      | 命令回执最大字符数（超出截断）                               | `1500`                |
| `list_page_size`       | 列表分页大小                                                 | `10`                  |
| `status_show_usage`    | `/状态` 是否显示上下文用量                                   | `true`                |

## 💬 命令

| 命令                           | 说明                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `/会话 [序号]`                 | 列出 / 选择当前工作区的会话（列表项 = 序号 + 标题 + 相对活跃时间；最新在前）。可见性与 WebUI 侧边栏一致：隐藏已归档、隐藏 subagent 子会话、空白会话仅当前受控时可见；归档会话不可按序号/标题选中 |
| `/切换 [工作区]`               | 列出 / 选择工作区作用域（支持序号 / 路径 / 标题）；**切换会清空控制目标**；列表里的「会话 N」不计归档 |
| `/新建 [路径]`                 | 在**当前选中的工作区**新建会话；未选中工作区则回退默认工作区；路径未注册会自动注册 |
| `/状态`                        | 目标标题 / 所属工作区 / 模型 / 思考强度 / 权限档位 / 忙闲 / 上下文用量 |
| `/压缩`                        | 压缩当前会话历史（等价 DSH 的 `/compact`）；先回「正在压缩…」、完成后追加结果；**不可中断** |
| `/模型 [模型名或 供应商/模型]` | 查看 / 切换模型                                              |
| `/思考 [强度]`                 | 查看 / 切换思考强度                                          |
| `/权限 [档位]`                 | 查看 / 切换权限预设                                          |
| `/停止`                        | 中断当前会话正在生成的回复                                   |
| `/帮助`                        | 命令清单与用法                                               |
| `/下一页` `/上一页`            | 列表翻页（跨页连续编号）；**不在 `/帮助` 中列出**，仅当列表超过 1 页（>10 条）时随列表页脚提示 |

**审批**：收到「需要你批准一次操作」时，回复 `y`（或 `是`/`允许`/`同意`/`批准`/`1`/`好`/`可以`）→ 仅本次允许；`n`（或 `否`/`拒绝`/`2`/`不`）→ 拒绝；`/取消` → 取消。超时 300 秒按拒绝处理。

**提问**：选择题回复序号（多选用逗号，如 `1,3`），也可直接回复自定义文本；`/跳过` 跳过当前题，`/取消` 放弃整次提问。超时 300 秒视为未作答。

> 审批 / 提问只接管**当前正被远程受控的会话**；非受控会话的审批 / 提问完整委派给 WebUI，互不干扰。受控会话的卡片只进 QQ（不进 WebUI）是预期行为。卡片按被动回复投递；仅当完全无锚点时降级为主动消息。文案不含 emoji。

## 🛠️ 开发

```bash
cd <本仓库目录>
pnpm install
pnpm build             # tsc + 客户端 UI 打包（dist/client.js）
pnpm test              # 先 build 再跑契约测试
```

## 📄 License

[MIT](LICENSE)