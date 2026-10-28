import { Schema } from 'koishi'

/** 🔬 验证类型 */
export const enum VerifyType {
  /** 🧪 手性碳验证 */
  CARBON = 'carbon',
  /** 🔢 数字验证 */
  MATH = 'math',
}

/** 📊 验证状态 */
export const enum VerifyStatus {
  /** ⏳ 待验证 */
  PENDING = 'pending',
  /** ✅ 已通过 */
  PASSED = 'passed',
  /** ❌ 已失败 */
  FAILED = 'failed',
  /** ⏰ 已超时 */
  EXPIRED = 'expired',
}

/** 📋 群配置 */
export interface GroupConfig {
  /** 🏷️ 群号 */
  guildId: string
  /** 🔛 是否启用验证 */
  enabled: boolean
  /** 🧪 是否使用手性碳模式 */
  useCarbonMode: boolean
  /** 💪 是否启用困难模式（需要答出所有区域） */
  hardMode: boolean
  /** 💡 是否显示提示 */
  showHint: boolean
}

/** 🧠 验证会话（内存中的验证状态） */
export interface VerifySession {
  /** 🏷️ 群号 */
  guildId: string
  /** 👤 用户ID */
  userId: string
  /** 🔬 验证类型 */
  type: VerifyType
  /** ✏️ 正确答案（数字或区域数组） */
  answer: number | string[]
  /** 🔄 已尝试次数 */
  attempts: number
  /** 🕐 创建时间 */
  createdAt: number
  /** ⏰ 过期时间 */
  expiresAt: number
  /** 🖼️ 题目图片 base64（仅手性碳模式） */
  imageBase64?: string
  /** 🔘 已点选的区域（困难模式下点按钮累积，点「提交答案」才判定） */
  picks?: string[]
}

/** 💾 验证记录（数据库持久化） */
export interface VerifyRecord {
  id: number
  guildId: string
  userId: string
  platform: string
  type: string
  attempts: number
  /** 连续失败轮数（禁言时长翻倍用） */
  failRounds: number
  status: string
  createdAt: number
  /** 本次验证的过期时间戳 */
  expiresAt: number
  /** 等待期结束时间戳（禁言到期后重新发题目）；0 表示没有等待期 */
  notBefore: number
  completedAt?: number
}

/** 👑 主人账号配置 */
export interface MasterAccount {
  platform: string
  userId: string
  enabled: boolean
}

/** ⚙️ 插件配置 */
export interface Config {
  /** 🔛 是否全局启用验证 */
  enabled: boolean
  /** 🌐 手性碳 API 地址 */
  carbonApiUrl: string
  /** ⏱️ API 请求超时时间（毫秒） */
  apiTimeout: number
  /** 🖼️ QQ 平台用 markdown 发送题目图片（需要 assets 服务上传拿公网地址） */
  qqMarkdownImage: boolean
  /** 📐 QQ markdown 图片的显示宽度上限（px） */
  markdownImageWidth: number
  /** ⏳ 验证超时时间（秒） */
  verifyTimeout: number
  /** 🔢 最大尝试次数 */
  maxAttempts: number
  /** 🗑️ 是否撤回错误回答 */
  recallWrongAnswer: boolean
  /** 👢 验证失败处理方式：none 不处理 / kick 踢出群 / ban 禁言后重试 */
  failAction: 'none' | 'kick' | 'ban'
  /** 🚫 禁言时长（分钟），禁言结束后自动重新发起验证 */
  banDuration: number
  /** 📈 禁言时长是否逐轮翻倍（1→2→4→8…） */
  banDurationDoubling: boolean
  /** 🛑 禁言时长上限（分钟），翻倍涨到这个值就不再涨 */
  banDurationMax: number
  /** 🔘 QQ 平台在题目消息里带按钮（区域代号按钮 + 提交/换一题），需要 qq-crack 适配器 */
  verifyButtons: boolean
  /** 🎛️ 按钮上出现的候选区域代号，逗号分隔 */
  buttonRegions: string
  /** 🔔 超时前提醒时间（秒），0 为不提醒 */
  reminderBeforeTimeout: number
  /** 📅 重新验证最大入群天数（超过则拒绝，0 为不限制） */
  reverifyMaxJoinDays: number
  /** 👑 主人账号列表（可绕过验证） */
  masterAccounts: MasterAccount[]
  /** 📋 群配置列表 */
  groupConfigs: GroupConfig[]
  /** 💬 自定义文案 */
  messages: {
    verifyPass: string
    verifyFail: string
    verifyTimeout: string
    mathPrompt: string
    carbonPrompt: string
    wrongAnswer: string
    timeoutReminder: string
    memberLeft: string
    bypassSuccess: string
    verifyBanned: string
  }
}

/** ⚙️ 配置 Schema */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('🔛 是否全局启用入群验证'),
    carbonApiUrl: Schema.string()
      .default('https://carbon.crystelf.top')
      .description('🌐 手性碳验证 API 地址'),
    apiTimeout: Schema.number()
      .default(10000)
      .min(1000)
      .max(60000)
      .step(1000)
      .description('⏱️ API 请求超时时间（毫秒）'),
    qqMarkdownImage: Schema.boolean()
      .default(true)
      .description('🖼️ QQ 平台用 markdown 发送题目图片（图片先上传到 assets 服务拿公网地址；没装 assets 或上传失败会自动退回普通图片）'),
    markdownImageWidth: Schema.number()
      .default(420)
      .min(100)
      .max(1080)
      .step(10)
      .description('📐 QQ markdown 图片的显示宽度上限（px），高度按图片真实比例缩放，不会拉伸'),
  }).description('🔧 基础配置'),

  Schema.object({
    verifyTimeout: Schema.number()
      .default(120)
      .min(0)
      .max(600)
      .step(10)
      .description('⏳ 验证超时时间（秒），填 0 表示**不限时**（不会超时，也不会因为超时踢人/禁言）'),
    maxAttempts: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .step(1)
      .description('🔢 最大尝试次数'),
    recallWrongAnswer: Schema.boolean()
      .default(true)
      .description('🗑️ 是否撤回错误回答'),
    failAction: Schema.union([
      Schema.const('kick').description('👢 踢出群聊'),
      Schema.const('ban').description('🚫 禁言一段时间，禁言结束后自动重新发起验证'),
      Schema.const('none').description('💤 不做处理，仅提示验证失败'),
    ])
      .default('kick')
      .description('👢 验证失败（次数用完或超时）时的处理方式'),
    banDuration: Schema.number()
      .default(10)
      .min(1)
      .max(1440)
      .step(1)
      .description('🚫 基础禁言时长（分钟），仅在处理方式为「禁言」时生效；禁言结束后会自动重新发送题目'),
    banDurationDoubling: Schema.boolean()
      .default(true)
      .description('📈 禁言时长逐轮翻倍：同一个成员每失败一轮，禁言时间乘以 2（1→2→4→8…），到上限为止'),
    banDurationMax: Schema.number()
      .default(60)
      .min(1)
      .max(1440)
      .step(1)
      .description('🛑 禁言时长上限（分钟）：翻倍涨到这里就不再增加，防止禁言时间失控'),
    verifyButtons: Schema.boolean()
      .default(true)
      .description('🔘 QQ 平台在题目消息里附带区域代号按钮（A1、B2…），点按钮即作答；只有正在验证的那个人点了才有反应（需要 qq-crack 这类支持 INTERACTION_CREATE 的适配器）'),
    buttonRegions: Schema.string()
      .role('textarea')
      .default('auto')
      .description('🎛️ 按钮上的候选区域代号。`auto`（默认）= 从题目图里按棋盘格配色自动数格子（相邻格子异色、斜对角同色 → 能得出 5 列 × 3 行 = A1…E3）；也可以直接填一串代号覆盖它，如 `A1,A2,A3,B1,B2,B3,C1,C2,C3,D1,D2,D3`'),
    reminderBeforeTimeout: Schema.number()
      .default(60)
      .min(0)
      .max(300)
      .step(10)
      .description('🔔 超时前提醒时间（秒），0 为不提醒'),
    reverifyMaxJoinDays: Schema.number()
      .default(1)
      .min(0)
      .max(365)
      .step(1)
      .description('📅 重新验证允许的最大入群天数，入群超过该天数的成员将拒绝重新验证（0 为不限制）'),
  }).description('⏱️ 验证行为配置'),

  Schema.object({
    masterAccounts: Schema.array(Schema.object({
      platform: Schema.string()
        .description('🖥️ 平台名称，如 onebot')
        .required(),
      userId: Schema.string()
        .description('👤 用户ID')
        .required(),
      enabled: Schema.boolean()
        .description('🔛 是否启用')
        .default(true),
    }))
      .role('table')
      .default([])
      .description('👑 主人账号列表（可绕过验证）'),
  }).description('👑 主人账号配置'),

  Schema.object({
    groupConfigs: Schema.array(Schema.object({
      guildId: Schema.string()
        .description('🏷️ 群号')
        .required(),
      enabled: Schema.boolean()
        .description('🔛 启用验证')
        .default(true),
      useCarbonMode: Schema.boolean()
        .description('🧪 使用手性碳模式')
        .default(true),
      hardMode: Schema.boolean()
        .description('💪 困难模式（需答出所有区域）')
        .default(false),
      showHint: Schema.boolean()
        .description('💡 显示提示')
        .default(true),
    }))
      .role('table')
      .default([])
      .description('📋 群单独配置（未配置的群使用全局默认）'),
  }).description('📋 群配置'),

  Schema.object({
    messages: Schema.object({
      verifyPass: Schema.string()
        .default('验证通过，欢迎加入本群~')
        .description('✅ 验证通过时的文案'),
      verifyFail: Schema.string()
        .default('验证失败，你错太多次啦！')
        .description('❌ 验证失败时的文案'),
      verifyTimeout: Schema.string()
        .default('验证超时啦！请重新申请入群~')
        .description('⏰ 验证超时时的文案'),
      mathPrompt: Schema.string()
        .default('请在 {timeoutText}内发送 {expression} 的计算结果~')
        .description('🔢 数学验证提示文案，可用变量: {timeout}, {timeoutText}, {expression}'),
      carbonPrompt: Schema.string()
        .role('textarea')
        .default('上图中有一块或多块区域含有手性碳原子\n为了加入本群，你需要在 {timeoutText}内正确找出{modeHint}\n回答时，直接发送区域代号即可，多个区域用逗号隔开\n提示：本图共有 {regionCount} 块手性碳区域~')
        .description('🧪 手性碳验证提示文案，可用变量: {timeout}, {timeoutText}, {modeHint}, {regionCount}'),
      wrongAnswer: Schema.string()
        .default('回答错了呢，你还有 {remaining} 次机会，再试试看？')
        .description('💬 答错时的文案，可用变量: {remaining}'),
      timeoutReminder: Schema.string()
        .default('小朋友，你还有 {seconds} 秒的时间完成验证噢~')
        .description('🔔 超时前提醒文案，可用变量: {seconds}'),
      memberLeft: Schema.string()
        .default('害，怎么跑路了')
        .description('🏃 成员退群时的文案'),
      bypassSuccess: Schema.string()
        .default('已绕过验证，欢迎加入本群~')
        .description('🛡️ 管理员绕过验证时的文案'),
      verifyBanned: Schema.string()
        .default('验证失败，你已被禁言 {minutes} 分钟\n禁言结束后会自动发新题目，届时请重新作答~')
        .description('🚫 验证失败被禁言时的文案，可用变量: {minutes}'),
    }).description('📝 自定义文案配置'),
  }).description('💬 自定义文案'),
])

/** 🗄️ 数据库表类型声明 */
declare module 'koishi' {
  interface Tables {
    chiral_verify_records: VerifyRecord
    chiral_group_configs: GroupConfig & { id: number }
  }
}
