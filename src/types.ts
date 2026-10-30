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

/** 🔬 验证方式 */
export type VerifyMode = 'message' | 'web' | 'quiz' | 'captcha'

/** ❓ 问卷题目（quiz 模式用；options 为换行分隔的选项文本，correct 为从 1 开始的序号列表） */
export interface QuizQuestion {
  /** 题干 */
  question: string
  /** 选项，每行一个（存储层用换行分隔的字符串） */
  options: string
  /** 正确选项的序号（从 1 开始，逗号分隔，可多选） */
  correct: string
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
  /** 网页验证：本轮已提交次数 */
  webAttempts: number
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
  /** 🔬 验证方式：message 群内作答 / web 网页作答（进群先禁言，点链接去网页答） */
  verifyMode: VerifyMode
  /** 🌐 网页验证的服务器地址，如 https://verify.example.com（最终地址 = 服务器地址/openid） */
  webServer: string
  /** 🔌 网页验证独占的端口（插件自己起一个 HTTP 服务，不占用 koishi 的端口） */
  webPort: number
  /** 🚫 网页验证模式下进群先禁言多久（分钟），默认 43200 = 30 天 */
  webBanMinutes: number
  /** 🔢 网页验证每次冷却前允许作答的次数 */
  webMaxAttempts: number
  /** ⏳ 网页验证次数用完后冷却多久（分钟） */
  webCooldownMinutes: number
  /** ❓ 问卷题目（quiz 模式用） */
  quizQuestions: QuizQuestion[]
  /** 🎯 问卷达成率（%）：答对题数占比 ≥ 该值即通过，默认 100（全对） */
  quizPassRate: number
  /** 🛡️ 启用 Cloudflare Turnstile 人机验证（只对网页类模式生效：web / quiz） */
  cfTurnstile: boolean
  /** 🔑 Turnstile Sitekey（站点密钥） */
  cfSiteKey: string
  /** 🔑 Turnstile Secret Key（服务端密钥，只做后端校验，不会下发到页面） */
  cfSecretKey: string
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
    webPrompt: string
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
      .description('⏳ 验证超时时间（秒），填 0 表示**不限时**（不会超时，也不会因为超时踢人/禁言）。网页验证模式下这个时间不生效（页面不过期）'),
    verifyMode: Schema.union([
      Schema.const('message').description('💬 群内作答：机器人发题目，用户在群里发区域代号 / 点按钮'),
      Schema.const('web').description('🌐 网页作答：进群先禁言，发提示 + 按钮，点开网页在网页里选题（不刷屏）'),
      Schema.const('quiz').description('❓ 问卷作答：网页里回答自定义问卷（可多选、按达成率判定）'),
      Schema.const('captcha').description('🛡️ 纯人机验证：网页里只做 Cloudflare Turnstile 人机验证，过了就解禁'),
    ])
      .default('message')
      .description('🔬 验证方式（可随时切换）'),
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
      .default('A1,A2,A3,B1,B2,B3,C1,C2,C3,D1,D2,D3,E1,E2,E3')
      .description('🎛️ 题目按钮 / 网页选项上的候选区域代号（默认 A1–E3 共 15 个，题目图最大就到 E3），逗号分隔'),
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
    webServer: Schema.string()
      .default('')
      .description('🌐 网页验证的服务器地址，例如 `https://verify.example.com`（**换了 `verifyMode = web` 时必须填**）。最终验证地址 = `服务器地址/openid`，例如 `https://verify.example.com:5140/A1B2C3D4...`；如果端口对外开放，记得把端口也写进来'),
    webPort: Schema.number()
      .default(5140)
      .min(1)
      .max(65535)
      .step(1)
      .description('🔌 网页验证页面独占的端口：插件会单独起一个 HTTP 服务监听这个端口（和 koishi 主端口互不影响），记得在防火墙/反向代理里放行'),
    webBanMinutes: Schema.number()
      .default(43200)
      .min(1)
      .max(44640)
      .step(1)
      .description('🚫 网页验证模式下，新成员进群先禁言多少分钟（默认 43200 = 30 天，最多 44640 = 31 天），验证通过后自动解禁'),
    webMaxAttempts: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .step(1)
      .description('🔢 网页验证一轮里允许提交几次答案，用完就进入冷却'),
    webCooldownMinutes: Schema.number()
      .default(10)
      .min(1)
      .max(1440)
      .step(1)
      .description('⏳ 网页验证次数用完后冷却多少分钟才能再试（冷却期间打开网页只显示剩余时间）'),
    quizQuestions: Schema.array(Schema.object({
      question: Schema.string()
        .role('textarea')
        .description('❓ 题干')
        .required(),
      options: Schema.string()
        .role('textarea')
        .description('📝 选项，**每行一个**')
        .required(),
      correct: Schema.string()
        .description('✅ 正确选项序号，从 1 开始，多选用逗号隔开（如 `2` 或 `1,3`）')
        .required(),
    }))
      .role('table')
      .default([])
      .description('❓ 问卷题目列表（quiz 模式用；至少配 1 题才能用问卷模式）'),
    quizPassRate: Schema.number()
      .default(100)
      .min(1)
      .max(100)
      .step(1)
      .description('🎯 问卷达成率（%）：答对题数占比 ≥ 这个值就算通过。默认 100 = 全对；设 60 = 10 题对 6 题就过'),
    cfTurnstile: Schema.boolean()
      .default(false)
      .description('🛡️ 启用 Cloudflare Turnstile 人机验证（**只对网页类模式生效**：web / quiz；captcha 模式本身就靠它）。需要在 Cloudflare 控制台创建 Turnstile Widget 并把域名填进 Hostname'),
    cfSiteKey: Schema.string()
      .default('')
      .description('🔑 Turnstile Sitekey（站点密钥，会下发到页面）。调试可用测试键 `1x00000000000000000000AA`（永远通过）'),
    cfSecretKey: Schema.string()
      .default('')
      .description('🔑 Turnstile Secret Key（服务端密钥，只做后端校验）。调试可用测试键 `1x0000000000000000000000000000000AA`（永远通过）'),
  }).description('🌐 网页验证（verifyMode = web / quiz / captcha 时生效）'),

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
      webPrompt: Schema.string()
        .role('textarea')
        .default('欢迎进群～为了防广告，进群后需要先验证一下\n你已被暂时禁言 {banText}，验证通过会自动解禁\n请点下面的按钮或打开网页作答，题目和选项都在网页里\n（每轮 {maxAttempts} 次机会，用完要等 {cooldown} 分钟）')
        .description('🌐 网页验证模式的进群提示，和链接一起发。可用变量: {banText} {minutes} {url} {maxAttempts} {cooldown}'),
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
