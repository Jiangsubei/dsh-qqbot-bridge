# 快速上手指南 (Getting Started)

本文档说明 **dsh-qqbot-bridge** 的运行环境要求、安装方式、QQ 开放平台凭据获取与配置，以及首次在 QQ 单聊中接管 DeepSeek Harness (DSH) 会话的完整流程。

---

## 1. 前置条件

- **Node.js**：`>= 20.0.0`（使用了内置全局 `WebSocket` 与 `fetch`；在 Node 22+ 环境下已充分验证）
- **DeepSeek Harness (DSH)**：`>= 0.2.0`（当前依赖已对齐并验证至 `0.2.2-rc.5`）
- **pnpm**：源码克隆与本地构建时需要（仓库使用 `pnpm` 工作区配置）
- **QQ 开放平台机器人**：已在 [QQ 开放平台](https://q.qq.com/) 创建的 QQ 机器人，具备 `AppID` 与 `AppSecret`，且测试用 QQ 账号已与机器人建立好友关系

> [!NOTE]
> 本插件**仅支持 QQ 单聊（C2C）**，且采用被动/好友直连模型，不做群聊、频道与自建鉴权层，依赖 QQ 开放平台自带的 `openid` 与好友关系校验。

---

## 2. 安装插件

### 方式一：通过 DSH 插件管理安装（推荐）

```bash
# 推荐：安装到 DSH 的 web profile
dsh plugin --profile web add dsh-qqbot-bridge

# 或安装到全局默认环境
dsh plugin add dsh-qqbot-bridge
```

如果使用 DSH 桌面端，也可以在客户端 **「设置」→「插件」→「添加插件」** 中输入 `dsh-qqbot-bridge` 安装并启用。

### 方式二：从源码克隆并 link 安装（本地开发）

```bash
git clone https://github.com/Jiangsubei/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge

pnpm install
# 必须先构建：DSH 通过 package.json 的 main（dist/index.js）与 ./client（dist/client.js）加载产物
pnpm build

# link 到 DSH 的 web profile
dsh plugin --profile web add link:.
```

> [!IMPORTANT]
> 本地开发修改 `src/` 后**必须重新执行 `pnpm build`**，否则 DSH 运行时仍会加载旧的 `dist/` 编译产物。

---

## 3. 配置 QQ 机器人凭据

1. 登录 [QQ 开放平台](https://q.qq.com/)，进入机器人管理页获取 **AppID** 与 **AppSecret**（若开启 IP 白名单，需放行运行 DSH 宿主的出口 IP）。
2. 插件按以下优先级（高到低）解析凭据：
   1. **进程环境变量**：`QQ_BOT_APP_ID` / `QQ_BOT_SECRET`
   2. **DSH 凭据文件**：`$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）的 `refs` 字段：
      ```yaml
      refs:
        QQ_BOT_APP_ID: "<你的 AppID>"
        QQ_BOT_SECRET: "<你的 AppSecret>"
      ```
   3. **插件设置面板**：在 WebUI 的 **「QQ 机器人」→「连接」** 分区填写 `app_id` 与 `app_secret`。

> [!TIP]
> 生产环境建议将 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` 写入 `$DSH_HOME/.credentials.yaml` 或环境变量，设置面板中的 `app_secret` 保持留空，避免将明文密钥写入 profile 配置。

如果启动时未检测到有效凭据，插件会进入**离线待机**状态（不连接 QQ 网关，但仍挂载 WebUI 设置面板与 REST 接口）；一旦在设置面板填写并保存凭据，插件会自动热上线并连接网关，无需重启 DSH。

---

## 4. 启动与首次使用

启动 DSH Web 服务：

```bash
dsh --profile web
```

默认可在浏览器访问 `http://127.0.0.1:3080/` 打开 WebUI（包含 **「QQ 机器人」** 设置卡片）。

在手机或桌面端 QQ 向你的机器人发送单聊消息即可开始控制：

1. **首次直发（零配置自动新建）**
   - 当未选中任何会话且 `allow_create_session` 为开启状态（默认开启）时，直接发送普通消息：
   - 插件会自动在默认工作区（`$DSH_HOME/workspace/default`，或配置的 `default_workspace`）新建一个会话（并同步出现在 WebUI 侧边栏），回复一条仅包含工作区名的提示后，立即将该消息作为第一个 prompt 转发给 Agent。
2. **接管已有工作区与会话**
   - 发送 `/切换` 列出所有已注册工作区，发送 `/切换 <序号|路径|标题>` 选定工作区（**会清空当前控制目标以防误发**）；
   - 发送 `/会话` 列出该工作区下的可用会话，发送 `/会话 <序号|标题>` 接管目标会话；
   - 之后直接发送文本、图片、语音或文件，均会转发给该受控会话。
3. **远程审批与提问**
   - 当受控会话触发工具审批（`approval/request`）或向用户提问（`user-questions/request`）时，插件会在 QQ 侧下发 Markdown 卡片与内联按钮；
   - 可直接点击按钮，或按提示回复 `y`/`n`、选项序号或自定义文本完成应答。
