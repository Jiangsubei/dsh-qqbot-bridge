# dsh-qqbot-bridge 文档中心

欢迎查阅 **dsh-qqbot-bridge**（DeepSeek Harness × QQ 官方 Bot API v2 单聊远程控制桥接插件）的技术文档。

本文档库内容均严格对齐仓库实际实现代码，覆盖快速安装、运行时配置、命令与远程交互、系统架构及故障排查。

---

## 文档导航

| 文档 | 内容摘要 | 适用对象 |
|---|---|---|
| **[快速上手指南 (getting-started.md)](getting-started.md)** | 运行时前置条件、桌面端 / CLI / 源码安装、QQ 开放平台凭据配置、首次启动与单聊接管流程 | 初次部署与快速体验者 |
| **[运行时配置参考 (configuration.md)](configuration.md)** | 三级凭据解析、WebUI 四分区 11 项参数字典、`volatile` 热更新、REST 配置接口与旧版配置迁移 | 日常配置与运维人员 |
| **[命令系统、交互与工具手册 (commands-and-interactions.md)](commands-and-interactions.md)** | 10 个主命令与分页子命令、英文别名表、审批/提问卡片与按钮机制、`send_file` / `send_image` 工具及入站附件 | 日常操控与 Agent 协作使用者 |
| **[系统架构与实现机制 (architecture.md)](architecture.md)** | Cordis 插件装配、入站 6 阶段管线、DSH 会话接管与回合归属、出站流式状态机与降级链路、富媒体双向传输 | 贡献者与二次开发者 |
| **[常见问题排查 (troubleshooting.md)](troubleshooting.md)** | 凭据缺失待机、网关断连、被动回复限额与去重（`40054005` / `40034005` / `40034128`）、会话锁冲突及真机探针清单 | 排障与协议验证人员 |

---

## 相关链接

- [项目根目录 README](../README.md)
- [开发日志与实测归档（devlog/README.md）](../devlog/README.md)
- [QQ 开放平台官网](https://q.qq.com/)
- [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh)
- [MIT 开源许可证](../LICENSE)
