# 运行时配置参考 (Configuration)

本文档详细介绍 **dsh-qqbot-bridge** 的凭据解析优先级、WebUI 4 分区共 11 项运行参数、热更新机制以及旧版配置迁移行为，所有字段名称、类型与默认值均直接对应 [src/config/schema.ts](../src/config/schema.ts) 与 [src/constants/index.ts](../src/constants/index.ts)。

---

## 1. 凭据安全与配置机制

### 1.1 凭据三级解析优先级

在 [src/config/credentials.ts](../src/config/credentials.ts) 中，`resolveCredentials()` 按如下优先级读取 `AppID` 与 `AppSecret`：

1. **进程环境变量**：`QQ_BOT_APP_ID`、`QQ_BOT_SECRET`
2. **DSH 凭据库**：`$DSH_HOME/.credentials.yaml` 下 `refs:` 块中的 `QQ_BOT_APP_ID`、`QQ_BOT_SECRET`（`DSH_HOME` 缺省为 `~/.dsh`）
3. **插件配置字段**：`app_id`、`app_secret`

`app_id` 与 `app_secret` 各自独立按上述顺序回退；任一项最终为空时，插件进入离线待机状态并输出缺失原因日志。

### 1.2 WebUI 脱敏与 REST 配置通道

插件通过 [src/server/routes.ts](../src/server/routes.ts) 注册服务端路由 `/plugins/dsh-qqbot-bridge/config`：

- **`GET /plugins/dsh-qqbot-bridge/config`**：返回当前配置、`baseDefaults` 及 `hasSecret` 布尔标记；响应中的 `config.app_secret` 固定置为 `''`，**绝不向前端回显明文密钥**。
- **`POST /plugins/dsh-qqbot-bridge/config`**：接收新配置并持久化至 DSH `settings` 服务（`settings.mutate` / `settings.update`），随后触发 `queueReconcile` 热更新。若提交的 `app_secret` 为空字符串且现有配置已存有密钥，服务端自动保留原密钥。

### 1.3 `volatile` 动态热更新

[src/config/schema.ts](../src/config/schema.ts) 中全部 11 个配置项均声明为 `.volatile()`。插件监听 `loader/volatile-update` 与 `settings/document-updated` 事件：

- **非凭据参数变更**（如 `stream_enabled`、`stream_throttle_ms`、`allow_create_session`、`media_dir`、`media_max_bytes`、`reply_max_chars`、`list_page_size`、`status_show_usage`、`default_workspace`）：直接通知运行中实例热更新，无需重连 QQ WebSocket。
- **凭据或 `default_workspace` 需要重建连接时**：若检测到有效凭据变化（包括初始离线待机后补填凭据），插件会自动销毁旧连接并按新凭据重新装配运行链路。

### 1.4 旧版 `settings.yaml` 静默迁移

在 Cordis `ready` 事件触发后，[src/config/migrate.ts](../src/config/migrate.ts) 会异步执行 `migrateLegacyConfig()`：

- 若当前 `app_id` 为空，且检测到 `$DSH_HOME/settings.yaml` 或 `$DSH_HOME/settings.yaml.imported` 中存在 `dsh-qqbot-bridge` 块，则静默将其迁移写入当前 profile 的 `settings` 服务（带 3 秒超时保护，不阻断启动）。

---

## 2. 配置参数字典（WebUI 4 分区 · 11 项）

WebUI 设置卡片（[src/client/card.tsx](../src/client/card.tsx)）将全部 11 个参数划分为 4 个 Tab 分区：

### 分区一：连接 (`connection`)

| 配置键名 | 显示名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `app_id` | AppID | `string` | `''` | QQ 开放平台机器人 AppID；留空则读取环境变量或 `.credentials.yaml` |
| `app_secret` | AppSecret | `string` (secret) | `''` | QQ 开放平台机器人 AppSecret；建议留空走 `.credentials.yaml` |
| `default_workspace` | 默认工作区 | `string` | `''` | 未选中工作区时自动新建会话的默认落点；留空使用 `$DSH_HOME/workspace/default`（首次使用时自动建目录并注册） |

### 分区二：行为 (`behavior`)

| 配置键名 | 显示名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `stream_enabled` | 流式输出 | `boolean` | `true` | 开启后正文通过 QQ `stream_messages` 流式逐片下发；关闭则改为普通 Markdown 消息整发 |
| `stream_throttle_ms` | 流式节流间隔（毫秒） | `number` | `1000` | 流式增量聚合与下发的最小节流间隔（毫秒）；流式单次请求正文上限设为 8 KiB（UTF-8 字节） |
| `allow_create_session` | 允许新建会话 | `boolean` | `true` | 同时管控 `/新建` 命令与「未选中会话时直发普通消息自动新建」；关闭后两类新建均被拒绝 |

### 分区三：文件 (`files`)

| 配置键名 | 显示名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `media_dir` | 附件落盘目录 | `string` | `'qqbot/media'` | 入站附件保存目录；写相对路径时相对于 `$DSH_HOME` 解析，也支持绝对路径 |
| `media_max_bytes` | 附件大小上限（字节） | `number` | `209715200` | 单个入站附件的落盘字节上限（默认 200 MiB，与 QQ 平台硬限制一致） |

### 分区四：命令 (`commands`)

| 配置键名 | 显示名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `reply_max_chars` | 回执长度上限（字符） | `number` | `1500` | 命令回执纯文本的最大字符数，超出按该长度截断并加 `…` |
| `list_page_size` | 列表分页大小 | `number` | `10` | `/会话` 与 `/切换` 列表每页展示条数（跨页保持连续编号） |
| `status_show_usage` | 状态显示上下文用量 | `boolean` | `true` | 关闭后 `/状态` 回执省略上下文 Token 用量统计行 |

---

## 3. 明确不提供的配置项（范围边界）

为保持插件专注于「C2C 单聊远程控制 DSH 会话」这一边界，本插件**故意不包含**以下配置：

- 群聊 / 频道白名单或开关（本项目仅做单聊 C2C）
- 多用户管理员列表或自研权限/鉴权 Token（依赖 QQ 平台自身好友关系与 `openid`）
- 插件自有模型/记忆/人格配置（模型与权限完全直通 DSH 官方服务，不维护第二份状态）
- 客户端被动回复次数或时间窗口预拦截配置（平时按被动回复下发，仅当平台真实返回 `40034005` / `40034128` 时自动降级为主动消息重试）
