/**
 * dsh-qqbot-bridge：中文（zh-CN）用户可见文案集中表
 *
 * 收录范围：面向用户呈现的全部交互文本
 * - QQ 单聊交互：命令回执、入站引导提示、审批与提问消息；
 * - WebUI 设置面板：卡片标题、Tab 分区、字段标签、描述提示与操作按钮；
 * - Agent 工具契约：工具调用描述与执行回执。
 *
 * 本文件为零依赖纯常量表，同时被服务端与 WebUI client bundle 共享。
 */

export const zhCN = {
  // ────────────────────────── 插件身份 ───────────────────────────
  plugin: {
    /** 设置卡片主标题 */
    name: 'QQ 官方机器人',
    /** 设置卡片副标题 */
    description: 'QQ 官方 Bot API 单聊接入',
  },

  // ─────────────────────── 共享提示（命令层与入站层同源） ───────────────────────
  common: {
    /** 未选中控制目标：命令层与入站层必须逐字一致（此前两处各写一份） */
    noTarget: '请先 /会话 选会话（该消息未发送给会话）。',
    /** 控制目标已归档（control.validateTarget 与入站回执同源） */
    targetArchived: '原控制目标已被归档，请用 /会话 重新选择。',
    /** 控制目标已不存在（control.validateTarget 与入站回执同源） */
    targetMissing: '原控制目标已不存在，请用 /会话 重新选择。',
    /** 通用失效兜底（无法判定归档/不存在时） */
    targetInvalid: '原控制目标已失效，请重新 /会话 选择会话。',
    /** 目标状态暂时查不出来（存储故障等）——如实说明，不假装有效 */
    targetCheckFailed: '暂时无法确认控制目标状态（{{error}}），请稍后重试。',
    /** 接管一个正被占用的会话（可能是 WebUI 正在使用） */
    sessionBusy: '该会话正被占用（可能正在被 WebUI 使用），请稍后重试或换一个会话。',
  },

  // ─────────────────────────── QQ 命令回执 ───────────────────────────
  commands: {
    help: {
      title: '【命令帮助】',
      body: [
        '- /会话：列出当前工作区的会话',
        '- /会话 <序号|标题>：切换控制目标',
        '- /切换：列出所有工作区',
        '- /切换 <序号|路径>：切换工作区（会清空当前控制目标）',
        '- /新建 [路径]：新建会话；未注册的路径会自动注册',
        '- /停止：中断当前会话正在生成的回复',
        '- /状态：查看控制目标、工作区、模型、思考强度、权限与上下文用量',
        '- /压缩：压缩当前会话历史（不可中断）',
        '- /模型 [名称]：查看或切换当前会话模型',
        '- /思考 [档位]：查看或切换思考强度',
        '- /权限 [档位]：查看或切换权限预设',
        '- /帮助：查看本帮助',
      ].join('\n'),
    },

    unknown: {
      /** C-R5：必须明确「该消息未发送给会话」 */
      reply: '未知命令：{{label}}（该消息未发送给会话）\n输入 /帮助 查看可用命令。',
      /** 命令名为空（只发了一个 `/`）时的代称 */
      genericLabel: '该命令',
    },

    sessions: {
      header: '当前工作区会话（第 {{page}}/{{totalPages}} 页，共 {{total}} 条）：',
      empty: '（当前工作区没有会话）',
      /** 有相对时间：`<序号>. <标题> <相对时间>` */
      rowWithTime: '{{num}}. {{title}} {{time}}',
      /** 拿不到时间元数据时整段省略时间（绝不印「未知」） */
      row: '{{num}}. {{title}}',
      /** 空白会话的本地化标签（对齐 WebUI「新会话」） */
      blankTitle: '（新会话）',
      noScope: '尚未选择工作区，请先用 /切换 选择。',
      switched: '已切换控制目标：{{title}} ({{id}})',
      switchFailed: '切换失败（{{code}}）：{{reason}}',
      indexOutOfRange: '序号超出范围（1~{{max}}）。输入 /会话 查看列表。',
      indexMissing: '序号无效：未找到对应会话。',
      notFound: '未找到匹配的会话：{{query}}。输入 /会话 查看列表。',
      multi: '匹配到多个会话（候选如下），请用序号重选：',
      candidate: '{{num}}. {{title}}',
      /** 相对时间档位与 WebUI 逐档对齐（刚刚/N分钟/N小时/N天/N个月/N年） */
      time: {
        justNow: '刚刚',
        minutes: '{{n}}分钟',
        hours: '{{n}}小时',
        days: '{{n}}天',
        months: '{{n}}个月',
        years: '{{n}}年',
      },
    },

    workspaces: {
      header: '工作区列表（第 {{page}}/{{totalPages}} 页，共 {{total}} 条）：',
      empty: '（没有已注册的工作区）',
      row: '{{num}}. {{title}}  路径 {{path}}  会话 {{count}}',
      switched: '已切换工作区：{{label}}；控制目标已清空，请用 /会话 重新选择。',
      indexOutOfRange: '序号超出范围（1~{{max}}）。输入 /切换 查看列表。',
      indexMissing: '序号无效：未找到对应工作区。',
      notFound: '未找到工作区：{{query}}。输入 /切换 查看列表。',
      multi: '匹配到多个工作区（候选如下），请用序号选择：',
      candidate: '{{num}}. {{title}}  路径 {{path}}',
    },

    new: {
      disabled: '已禁用 QQ 侧新建会话；请用 /会话 选择已有会话。',
      stageExistsAsFile: '该路径是文件，不是目录',
      stageMkdirFailed: '创建目录失败',
      stageRegisterFailed: '注册工作区失败',
      stageCreateFailed: '创建会话失败',
      failed: '新建失败（{{stage}}）：{{reason}}',
      done: '已新建会话：{{sessionId}}\n工作区：{{workspace}}{{notes}}\n控制目标已切换为该会话。',
      noteWorkspace: '已自动注册工作区',
      noteDir: '已递归创建目录',
      notes: '（{{list}}）',
    },

    stop: {
      done: '已中断当前会话正在生成的回复。',
      failed: '停止失败：{{reason}}',
    },

    status: {
      title: '【控制目标状态】',
      target: '控制目标：{{title}} ({{id}})',
      none: '控制目标：未选中（请用 /会话 选择会话）',
      scope: '工作区作用域：{{scope}}',
      workspace: '工作区：{{title}} ({{path}})',
      model: '模型：{{value}}',
      effort: '思考强度：{{value}}',
      permission: '权限档位：{{value}}',
      running: '运行状态：{{value}}',
      busy: '运行中',
      idle: '空闲',
      usage: '上下文用量：{{value}}',
      /** 用量比例：`~12.3K / 128K (10%)` */
      usageRatio: '{{used}} / {{window}} ({{percent}}%)',
      unknown: '未知',
      unset: '未设置',
    },

    compact: {
      running: '正在压缩会话历史…',
      noArgs: '『/压缩』不接受参数。',
      done: '已压缩 {{items}} 条历史（约 {{tokens}} tokens）。',
      noop: '没有可压缩的历史（会话未变更）。',
      failed: '压缩失败：{{reason}}',
    },

    model: {
      unavailable: '模型服务不可用。',
      current: '当前模型：{{value}}',
      unknown: '未知',
      listHeader: '可用模型：',
      listEmpty: '（服务未返回任何模型）',
      listRow: '- {{provider}} / {{model}}',
      listRowWithName: '- {{provider}} / {{model}} ({{name}})',
      switchHint: '切换：/模型 <模型名> 或 /模型 <provider>/<model>',
      notFound: '未找到模型：{{arg}}。用 /模型 查看可用列表，或用 /模型 <provider>/<model> 指定供应商。',
      multi: '匹配到多个模型（候选如下），请指定供应商：',
      candidate: '- /模型 {{provider}}/{{model}}',
      switched: '当前会话模型已切换为：{{provider}} / {{model}}',
    },

    thinking: {
      unavailable: '思考强度服务不可用。',
      modelUnknown: '无法确定当前会话的模型，请先用 /模型 查看。',
      unsupported: '当前模型不支持思考强度设置：{{provider}} / {{model}}',
      currentModel: '当前模型：{{value}}',
      currentEffort: '当前思考强度：{{value}}',
      defaultLabel: '默认',
      listHeader: '支持档位：',
      listRow: '- {{id}} ({{name}})',
      badgeDefault: ' [默认]',
      badgeCurrent: ' (当前)',
      switchHint: '切换：/思考 <档位>（如 /思考 max）',
      switched: '思考强度已切换为：{{id}} ({{name}})',
      reset: '已恢复模型默认思考强度：{{provider}} / {{model}}',
      invalid: '无效的思考档位：{{arg}}\n当前模型支持：{{list}}',
    },

    permission: {
      unavailable: '权限服务不可用。',
      unknown: '未知',
      current: '当前权限档位：{{value}}',
      listHeader: '可用档位：',
      listRow: '- {{value}}',
      switchHint: '切换：/权限 <只读|编辑|完全>',
      invalid: '无效的权限档位：{{arg}}\n可用档位：{{list}}',
      switched: '权限档位已切换为：{{value}}',
      labelReadonly: '只读',
      labelEdit: '编辑',
      labelFull: '完全',
      /** 中文档位 + 官方 preset（便于与 DSH 侧核对；preset 名是通用术语，保留） */
      withPreset: '{{label}} ({{preset}})',
    },

    paging: {
      noList: '当前没有正在分页的列表，请先发送 /会话 或 /切换。',
      first: '已经是第一页（第 {{page}}/{{totalPages}} 页）。',
      last: '已经是最后一页（第 {{page}}/{{totalPages}} 页）。',
      footerPaging: '翻页：/下一页 /上一页；',
      footerSelectSessions: '选择：/会话 <序号|标题>',
      footerSelectWorkspaces: '选择：/切换 <序号|路径>',
    },
  },

  // ─────────────────────── 入站管线（未选中态与转发失败） ───────────────────────
  inbound: {
    autoCreateFailed: '无法自动新建会话，请用 /切换 选择工作区或 /新建 <路径> 后重试。',
    autoCreateReason: '（原因：{{reason}}）',
    autoCreateDone: '未选中会话：已在工作区「{{workspace}}」新建会话。',
    sendFailed: '发送到会话失败：{{reason}}',
    unknownReason: '未知原因',
    handlingFailed: '处理消息失败：{{message}}',
    followUpFailed: '追加回执失败：{{message}}',
  },

  // ─────────────────────── 远端交互（审批 / 提问） ───────────────────────
  interactions: {
    approval: {
      prompt: '需要你批准一次操作\n工具：{{tool}}{{reason}}\n\n回复 y 允许（仅本次）／n 拒绝',
      toolUnknown: '未知工具',
      reason: '\n原因：{{reason}}',
      timeout: '审批已超时（自动拒绝）',
      cancelled: '已取消该操作。',
      allowed: '已允许（仅本次）',
      rejected: '已拒绝该操作。',
      unrecognized: '未识别为批准指令（收到「{{text}}」），已按拒绝处理。',
    },
    question: {
      optionLine: '{{index}}. {{label}}',
      optionDesc: ' —— {{description}}',
      hintSingle: '回复序号即可；也可直接回复自定义文本',
      hintMulti: '回复序号（多选用逗号，如 1,3）；也可直接回复自定义文本',
      hintMultiQuestion: '（第 {{index}}/{{total}} 问，回复 /跳过 跳过、/取消 放弃）',
      hintSingleQuestion: '（回复 /取消 放弃本次提问）',
      cancelled: '提问已取消或超时。',
      unanswered: '用户未作答（超时或取消）',
    },
  },

  // ─────────────────────── 控制层（用户可见的失效与压缩原因） ───────────────────────
  control: {
    compact: {
      noTarget: '未选中控制目标。',
      unavailable: '压缩服务不可用：当前会话未挂载压缩能力。',
      agent: '无法接管该会话的 agent，压缩未执行。',
      busy: '本进程已有压缩在进行，或该会话不空闲；请等当前回合结束后重试。',
      cancelled: '压缩已取消。',
      changed: '待压缩的历史在压缩前被改动，会话未变更。',
      summary: '压缩未能产出有效摘要，会话未变更。',
      commit: '压缩未正常收尾，部分历史可能已变更，请先检查会话状态再重试。',
      persistence: '压缩已完成，但会话保存失败。',
      error: '压缩失败（未分类错误）。',
    },
    create: {
      /** `/新建` 前置失败：解析不出本次要用的 agent preset（D52）。`{{error}}` 是 DSH 原文原因 */
      presetResolveFailed: '解析 agent preset 失败：{{error}}',
    },
  },

  // ─────────────────────── 入站附件说明（写进会话正文，agent 与 WebUI 都可见） ───────────────────────
  media: {
    kindImage: '图片',
    kindVoice: '语音',
    kindFile: '文件',
    unknownType: '未知类型',
    /** 摘要行：`[附件 1/2] 图片：a.png（3 字节，image/png）已保存到 /path/a.png` */
    describe: '[附件 {{index}}/{{total}}] {{kind}}：{{name}}（{{bytes}} 字节，{{mime}}）已保存到 {{path}}',
    imageInjected: '；已作为图片注入本轮上下文',
    voiceTranscript: '；语音转写：{{text}}',
  },

  // ─────────────────────── Agent 工具（描述与回执） ──────────────────────
  tools: {
    kindImage: '图片',
    kindFile: '文件',
    description: '把本地{{kind}}发送到当前 QQ 单聊会话。只在用户明确要求发送或交付{{kind}}时调用；发送失败会如实返回错误，不要假装成功。',
    paramPath: '要发送的本地文件绝对路径',
    paramName: '可选：对端显示的文件名（缺省取本地文件名）',
    missingPath: '缺少 file_path 参数。',
    noTarget: '无法定位当前 QQ 单聊目标，请先在 QQ 侧选中要回复的会话。',
    mediaFailed: '富媒体发送失败：code={{code}} {{message}}',
    sent: '已发送{{kind}}：{{name}}（{{path}}）',
    failed: '{{kind}}发送失败：{{error}}',
    unknownError: '未知错误',
  },

  // ─────────────────────── Web UI 设置卡片 ───────────────────────
  settings: {
    tabs: {
      connection: '连接',
      behavior: '行为',
      files: '文件',
      commands: '命令',
    },
    card: {
      expand: '展开',
      collapse: '收起',
      tabsLabel: '设置分区',
      dirty: '未保存修改',
      discard: '放弃修改',
      save: '保存更改',
      saving: '保存中…',
      /** 字段级：该字段已被自定义（非默认值） */
      overridden: '已自定义',
      /** 字段级：恢复该字段默认值 */
      reset: '重置',
      saveConflict: '保存冲突：配置已被其他标签页修改，请刷新后重试。',
      saveFailed: '保存失败，请检查配置',
    },
    /** 设置桥接层的错误文案（`src/client/index.tsx`；原先直接抛英文技术串给用户看） */
    errors: {
      unavailable: '设置服务不可用，请刷新页面后重试。',
      rejected: '设置保存被拒绝，请刷新页面后重试。',
      conflict: '设置保存冲突，请刷新页面后重试。',
    },
    fields: {
      appId: {
        label: 'AppID',
        hint: 'QQ 开放平台的机器人 AppID；留空则读取 .credentials.yaml 中的凭据。',
        placeholder: '102xxxxxx',
      },
      appSecret: {
        label: 'AppSecret',
        hint: '建议留空：生产环境使用 .credentials.yaml 中的凭据，避免明文写入设置。',
      },
      defaultWorkspace: {
        label: '默认工作区',
        hint: '未选择工作区时的会话落点；留空则使用 $DSH_HOME/workspace/default。',
        placeholder: '/path/to/project',
      },
      streamEnabled: {
        label: '流式输出',
        hint: '正文以 QQ 流式消息逐段下发；关闭则改为普通消息。',
      },
      streamThrottleMs: {
        label: '流式节流间隔（毫秒）',
        hint: '分片下发的最小间隔，避免手机端刷新过频。',
        placeholder: '1000',
      },
      allowCreateSession: {
        label: '允许新建会话',
        hint: '关闭后 /新建 与未选中时的自动新建都会被拒绝。',
      },
      mediaDir: {
        label: '附件落盘目录',
        hint: '相对 DSH_HOME，也可写绝对路径。',
        placeholder: 'qqbot/media',
      },
      mediaMaxBytes: {
        label: '附件大小上限（字节）',
        hint: '单个入站附件的落盘上限（官方硬限制 200MB）。',
        placeholder: '209715200',
      },
      replyMaxChars: {
        label: '回执长度上限（字符）',
        hint: '超长回执按此长度截断。',
        placeholder: '1500',
      },
      listPageSize: {
        label: '列表分页大小',
        hint: '列表每页显示的条数。',
        placeholder: '10',
      },
      statusShowUsage: {
        label: '状态显示上下文用量',
        hint: '关闭后 /状态 不显示上下文用量。',
      },
    },
  },
} as const;