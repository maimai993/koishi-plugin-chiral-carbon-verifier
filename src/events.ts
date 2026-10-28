import { Bot, Context, h, Logger, Session } from 'koishi'
import { Config, VerifyRecord, VerifyStatus } from './types'
import { DatabaseService } from './database'
import { Verifier, renderTemplate } from './verifier'
import { WebVerifier } from './web-verify'
import { BUTTON_PREFIX, BUTTON_SUBMIT, BUTTON_CLEAR, parseRegionButtonData } from './qq-button'

const logger = new Logger('chiral-carbon-verifier:events')

/**
 * OneBot 原生 API（可选依赖）
 * 不直接 import koishi-plugin-adapter-onebot，避免未安装该适配器时编译失败
 */
export interface OneBotInternal {
  setGroupKick?(groupId: string, userId: string, rejectAddRequest?: boolean): Promise<unknown>
  setGroupBan?(groupId: string, userId: string, duration: number): Promise<unknown>
  getGroupMemberInfo?(groupId: string, userId: string, noCache?: boolean): Promise<any>
}

/** 取会话上的 onebot 原生 API（非 onebot 平台返回 undefined） */
export function getOnebot(session: Session): OneBotInternal | undefined {
  return (session as any).onebot
}

/** 取机器人的 onebot 原生 API（重启恢复时没有 session，用 bot.internal 判断） */
function getOnebotOfBot(bot: Bot): OneBotInternal | undefined {
  return (bot as any)?.internal
}

/**
 * 一次验证的处理目标。
 *
 * 有会话时由 `session` 构造；**重启恢复时没有会话**，就用数据库里的记录 + 在线的 bot 拼出来，
 * 所以踢人 / 禁言 / 发消息都只依赖这个对象，而不是 `Session`。
 */
export interface VerifyTarget {
  guildId: string
  platform: string
  userId: string
  bot: Bot
  /** 发送消息，返回消息 id 列表（失败返回 null，用于 markdown 失败后退回普通图片） */
  send: (content: h[]) => Promise<string[] | null>
}

/**
 * 从 `interaction/button` 会话里取**点击的人**的 id。
 *
 * INTERACTION_CREATE 事件带回的是点击者自己的 openid（群里是 `group_member_openid`），
 * qq-crack 会把它写进 `session.userId`；这里再兜底读事件体，保证拿到的一定是「谁点的」，
 * 而不是消息作者。
 */
function resolveClickUserId(session: any): string | undefined {
  const candidates = [
    session?.userId,
    session?.event?.button?.user_id,
    session?.event?.user?.id,
    session?.event?.member?.user?.id,
    session?.author?.id,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

/** 事件工具类 */
export class EventUtils {
  /** 等待结束后重新验证的定时器 Map<guildId_userId, disposer> */
  private reverifyTimers = new Map<string, () => void>()
  /** 答题点击的冷却（防止手抖连点白扣次数）Map<guildId_userId, timestamp> */
  private clickCooldown = new Map<string, number>()
  /** 题目消息 id Map<guildId_userId, messageIds> —— 答完/换题时用来撤回旧题目 */
  private questionMessages = new Map<string, string[]>()

  constructor(
    private ctx: Context,
    private config: Config,
    private db: DatabaseService,
    private verifier: Verifier
  ) {}

  private key(guildId: string, userId: string): string {
    return `${guildId}_${userId}`
  }

  /** 由会话构造处理目标（可以覆盖 userId，用于按钮回调这种「点击者 ≠ 会话默认用户」的场景） */
  targetOf(session: Session, userIdOverride?: string): VerifyTarget {
    return {
      guildId: session.guildId,
      platform: session.platform,
      userId: userIdOverride ?? session.userId,
      bot: session.bot,
      send: (content) => this.sendBySession(session, content),
    }
  }

  private async sendBySession(session: Session, content: h[]): Promise<string[] | null> {
    try {
      const ids = await session.send(content)
      return ids ?? []
    } catch (error) {
      logger.warn(`向 ${session.guildId} 发送消息失败:`, error)
      return null
    }
  }

  private async sendByBot(bot: Bot, channelId: string, content: h[]): Promise<string[] | null> {
    try {
      const ids = await bot.sendMessage(channelId, content)
      return ids ?? []
    } catch (error) {
      logger.warn(`向 ${channelId} 发送消息失败:`, error)
      return null
    }
  }

  /** 踢出用户 */
  async kickUser(target: VerifyTarget): Promise<boolean> {
    const { guildId, userId, bot } = target
    try {
      // OneBot 系走原生 API
      const onebot = getOnebotOfBot(bot)
      if (onebot?.setGroupKick) {
        await onebot.setGroupKick(guildId, userId, false)
        logger.info(`已踢出用户 ${userId} 从群 ${guildId}`)
        return true
      }

      // 标准 API（QQ 官方 / qq-crack 等）
      const api = bot as any
      if (typeof api.kickGuildMember === 'function') {
        await api.kickGuildMember(guildId, userId)
        logger.info(`已踢出用户 ${userId} 从群 ${guildId}`)
        return true
      }

      logger.warn(`无法踢出用户 ${userId}，当前适配器不支持`)
      return false
    } catch (error) {
      logger.error(`踢出用户 ${userId} 失败:`, error)
      return false
    }
  }

  /** 禁言用户（minutes 分钟） */
  async muteUser(target: VerifyTarget, minutes: number): Promise<boolean> {
    const { guildId, userId, bot } = target
    // 禁言单位：OneBot 用秒（且必须 >= 60），Satori / QQ 官方用毫秒
    const seconds = Math.max(60, Math.round(minutes * 60))

    try {
      const onebot = getOnebotOfBot(bot)
      if (onebot?.setGroupBan) {
        await onebot.setGroupBan(guildId, userId, seconds)
        logger.info(`已禁言用户 ${userId} ${minutes} 分钟（群 ${guildId}）`)
        return true
      }

      const api = bot as any
      if (typeof api.muteGuildMember === 'function') {
        await api.muteGuildMember(guildId, userId, seconds * 1000)
        logger.info(`已禁言用户 ${userId} ${minutes} 分钟（群 ${guildId}）`)
        return true
      }

      logger.warn(`无法禁言用户 ${userId}，当前适配器不支持`)
      return false
    } catch (error) {
      logger.error(`禁言用户 ${userId} 失败:`, error)
      return false
    }
  }

  /** 撤回消息 */
  async recallMessage(session: Session, messageId: string): Promise<boolean> {
    try {
      await session.bot.deleteMessage(session.channelId, messageId)
      return true
    } catch (error) {
      logger.warn(`撤回消息 ${messageId} 失败:`, error)
      return false
    }
  }

  /** 取消待执行的「等待结束后重新验证」 */  cancelReverify(guildId: string, userId: string): void {
    const key = this.key(guildId, userId)
    const dispose = this.reverifyTimers.get(key)
    if (dispose) {
      dispose()
      this.reverifyTimers.delete(key)
    }
  }

  /**
   * 点按钮的冷却：按「动作种类」分别计时（选中 / 提交 / 作答互不影响），
   * 主要防止手抖连点把答题次数白扣掉。
   */
  allowClick(guildId: string, userId: string, kind: string, cooldownMs: number): boolean {
    const key = `${this.key(guildId, userId)}_${kind}`
    const now = Date.now()
    const last = this.clickCooldown.get(key) ?? 0

    if (now - last < cooldownMs) {
      logger.info(`用户 ${userId} 的 ${kind} 点得太快，忽略这次点击`)
      return false
    }

    this.clickCooldown.set(key, now)
    return true
  }

  /** 到点后自动重新发起验证（禁言结束 / 重启恢复都走这里） */
  private scheduleReverify(target: VerifyTarget, delayMs: number): void {
    const { guildId, userId } = target
    this.cancelReverify(guildId, userId)

    const dispose = this.ctx.setTimeout(async () => {
      this.reverifyTimers.delete(this.key(guildId, userId))
      logger.info(`用户 ${userId} 的等待时间结束，重新发起验证`)
      await this.startVerifyAndWatch(target)
    }, Math.max(1000, delayMs))

    this.reverifyTimers.set(this.key(guildId, userId), dispose)
    logger.info(`用户 ${userId} 将在 ${Math.ceil(Math.max(1000, delayMs) / 60000)} 分钟后重新收到验证题目`)
  }

  /**
   * 按配置处理验证失败：踢出 / 禁言后重试 / 不处理
   * 注意：调用前请先发送失败提示文案
   */
  async applyFailAction(target: VerifyTarget): Promise<void> {
    const action = this.config.failAction ?? 'kick'
    const { guildId, userId } = target

    if (action === 'none') {
      logger.info(`用户 ${userId} 验证失败，按配置不做处理`)
      return
    }

    if (action === 'ban') {
      const minutes = await this.resolveBanMinutes(guildId, userId)
      const muted = await this.muteUser(target, minutes)

      if (muted) {
        // 记进数据库：重启后也能知道这个人「还在禁言等待中」，不至于漏掉验证
        await this.db.setNotBefore(guildId, userId, Date.now() + minutes * 60 * 1000)
      } else {
        // 禁言没成功（多半是没管理员权限）→ 记录结掉，别留个 pending 一直重发题目
        await this.db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.FAILED)
      }

      await target.send([
        h.at(userId),
        h.text('\n' + renderTemplate(this.config.messages.verifyBanned, { minutes })),
      ])

      if (muted) {
        this.scheduleReverify(target, minutes * 60 * 1000)
      } else {
        logger.warn(`禁言用户 ${userId} 失败，禁言结束后不会自动重新验证`)
      }
      return
    }

    await this.kickUser(target)
  }

  /**
   * 算这次禁言多久：基础时长按「连续失败轮数」翻倍（1 → 2 → 4 → 8 …），到上限为止。
   * 轮数记在数据库里，重启也不会清零。
   */
  private async resolveBanMinutes(guildId: string, userId: string): Promise<number> {
    const base = Math.max(1, Math.round(this.config.banDuration ?? 10))
    const max = Math.max(base, Math.round(this.config.banDurationMax ?? base))
    const rounds = (await this.db.getFailRounds(guildId, userId)) + 1

    let minutes = base
    if (this.config.banDurationDoubling) {
      // 2^(rounds-1)，轮数太大时没必要继续算（结果反正已经被上限压住了）
      const factor = Math.pow(2, Math.min(rounds - 1, 12))
      minutes = Math.min(base * factor, max)
    }

    await this.db.setFailRounds(guildId, userId, rounds)
    logger.info(
      `用户 ${userId} 第 ${rounds} 次验证失败，禁言 ${minutes} 分钟` +
        `（基础 ${base} / 上限 ${max} / 翻倍${this.config.banDurationDoubling ? '开' : '关'}）`
    )
    return minutes
  }

  /** 撤回题目消息（答对 / 判定结束 / 换一题时调用） */
  async recallQuestion(target: VerifyTarget): Promise<void> {
    const key = this.key(target.guildId, target.userId)
    const ids = this.questionMessages.get(key) ?? []
    this.questionMessages.delete(key)

    for (const id of ids) {
      try {
        await target.bot.deleteMessage(target.guildId, id)
      } catch (error) {
        logger.warn(`撤回题目消息 ${id} 失败:`, error)
      }
    }
  }

  /**
   * 统一的答题结果处理：群消息打字作答 和 点按钮作答 共用同一套逻辑。
   * 答错但还有机会时**不撤题目**（图还在，能接着看图再答）。
   */
  async handleAnswerResult(
    target: VerifyTarget,
    result: { passed: boolean; failed: boolean; message: string },
    options: { recallUserMessage?: () => Promise<unknown> } = {}
  ): Promise<void> {
    const reply = [h.at(target.userId), h.text('\n' + result.message)]

    if (result.passed) {
      await this.recallQuestion(target)
      await target.send(reply)
      return
    }

    if (result.failed) {
      if (options.recallUserMessage) await options.recallUserMessage()
      await this.recallQuestion(target)
      await target.send(reply)
      await this.applyFailAction(target)
      return
    }

    if (options.recallUserMessage) await options.recallUserMessage()
    await target.send(reply)
  }

  /** 发起验证，并设置超时提醒与超时处理 */
  async startVerifyAndWatch(target: VerifyTarget): Promise<boolean> {
    const { guildId, userId } = target

    const result = await this.verifier.startVerify(guildId, userId, target.platform)

    if (!result.success) {
      logger.error(`启动用户 ${userId} 的验证失败`)
      return false
    }

    // 发送验证消息（QQ 上优先 markdown 图片，发不出去再退回普通图片段）
    let ids = await target.send(result.message)
    if (!ids && result.fallbackMessage) {
      logger.warn(`用户 ${userId} 的 markdown 验证消息发送失败，退回普通图片重发`)
      ids = await target.send(result.fallbackMessage)
    }
    if (!ids) {
      logger.error(`向用户 ${userId} 发送验证消息失败`)
      return false
    }

    // 记住题目消息 id：答完/换题时好把旧题目撤掉（按钮回调不会刷屏，撤回由我们自己控制）
    this.questionMessages.set(this.key(guildId, userId), ids)

    // verifyTimeout = 0 表示不限时：既不发超时提醒，也不做超时处理，一直等用户答
    if (this.config.verifyTimeout <= 0) {
      logger.info(`用户 ${userId} 的验证不限时（verifyTimeout = 0），不设置超时处理`)
      return true
    }

    // 设置超时提醒
    if (this.config.reminderBeforeTimeout > 0 && this.config.verifyTimeout > this.config.reminderBeforeTimeout) {
      const reminderDelay = (this.config.verifyTimeout - this.config.reminderBeforeTimeout) * 1000

      this.ctx.setTimeout(async () => {
        if (this.verifier.isVerifying(guildId, userId)) {
          await target.send([
            h.at(userId),
            h.text('\n' + renderTemplate(this.config.messages.timeoutReminder, { seconds: this.config.reminderBeforeTimeout })),
          ])
        }
      }, reminderDelay)
    }

    // 设置超时处理
    this.ctx.setTimeout(async () => {
      if (this.verifier.isVerifying(guildId, userId)) {
        await this.verifier.handleTimeout(guildId, userId)

        await target.send([
          h.at(userId),
          h.text('\n' + this.config.messages.verifyTimeout),
        ])

        await this.applyFailAction(target)
      }
    }, this.config.verifyTimeout * 1000)

    return true
  }

  /** 挑一个该平台在线的机器人 */
  private pickBot(platform: string): Bot | undefined {
    const bots = this.ctx.bots ?? []
    return bots.find((bot) => bot.platform === platform)
  }

  /**
   * 重启后恢复未完成的验证（数据库里有 pending 记录的用户）。
   *
   * 解决的就是这个问题：**禁言等待中重启了 koishi，内存里的定时器和会话全丢了**，
   * 用户就再也不会被要求验证了。现在记录在数据库里，启动时：
   *   - 还在等待期（`notBefore` 未到）→ 睡到那个时间点再发新题目；
   *   - 已经过了等待期 → 立刻重新发题目，并重新计时。
   *
   * 太老的记录（机器人停机很久 / 用户早就不在了）直接标记过期，**不恢复也不处罚**，
   * 免得重启后误踢老群友。
   */
  async resumePending(): Promise<void> {
    let records: VerifyRecord[]
    try {
      records = await this.db.getPendingRecords()
    } catch (error) {
      logger.warn('读取未完成的验证记录失败，跳过恢复:', error)
      return
    }
    if (!records.length) return

    const now = Date.now()
    // 不限时（verifyTimeout = 0）时，未完成的验证按 24 小时算「还算新鲜」，别一重启就被判过期
    const verifyWindow = this.config.verifyTimeout > 0 ? this.config.verifyTimeout * 1000 : 24 * 60 * 60 * 1000
    const maxAge =
      Math.max(1, this.config.banDuration ?? 10) * 60 * 1000 +
      verifyWindow +
      10 * 60 * 1000
    let resumed = 0

    for (const record of records) {
      // 网页验证模式的记录：靠网页自己做，不需要重发题目
      if (this.config.verifyMode === 'web') {
        logger.info(`用户 ${record.userId} 的验证是网页验证模式，跳过群内重发`)
        continue
      }

      if (now - Number(record.createdAt ?? 0) > maxAge) {
        logger.info(`用户 ${record.userId} 的验证记录已过期（创建于 ${new Date(Number(record.createdAt ?? 0)).toLocaleString()}），跳过恢复`)
        await this.db.updateVerifyRecordStatus(record.guildId, record.userId, VerifyStatus.EXPIRED)
        continue
      }

      const bot = this.pickBot(record.platform)
      if (!bot) {
        logger.warn(`没有在线的 ${record.platform} 机器人，暂时跳过恢复用户 ${record.userId}`)
        continue
      }

      const target: VerifyTarget = {
        guildId: record.guildId,
        platform: record.platform,
        userId: record.userId,
        bot,
        send: (content) => this.sendByBot(bot, record.guildId, content),
      }

      const notBefore = Number(record.notBefore ?? 0)
      if (notBefore > now) {
        logger.info(`用户 ${record.userId} 仍在等待期（${Math.ceil((notBefore - now) / 60000)} 分钟后结束），恢复定时器`)
        this.scheduleReverify(target, notBefore - now)
      } else {
        logger.info(`用户 ${record.userId} 有待完成的验证，直接重新发题目`)
        await this.startVerifyAndWatch(target)
      }
      resumed++
    }

    if (resumed) logger.info(`已恢复 ${resumed} 个未完成的入群验证`)
  }
}

/** 注册事件监听器 */
export function registerEvents(
  ctx: Context,
  config: Config,
  db: DatabaseService,
  verifier: Verifier,
  web?: WebVerifier
): EventUtils {
  const utils = new EventUtils(ctx, config, db, verifier)

  // ==================== 群成员增加事件 ====================
  ctx.on('guild-member-added', async (session) => {
    const { guildId, userId, platform } = session

    logger.info(`[guild-member-added] 群 ${guildId} 新成员 ${userId}`)

    // 检查是否为 bot 自己
    if (userId === session.selfId) {
      logger.info('新成员是 bot 自己，跳过验证')
      return
    }

    // 检查是否为主人
    if (verifier.isMaster(platform, userId)) {
      logger.info(`用户 ${userId} 是主人，跳过验证`)
      return
    }

    // 获取群配置
    const groupConfig = await verifier.getGroupConfig(guildId)
    if (!groupConfig.enabled) {
      logger.info(`群 ${guildId} 未启用验证`)
      return
    }

    // 检查是否已在验证中
    if (verifier.isVerifying(guildId, userId)) {
      logger.info(`用户 ${userId} 已在验证中`)
      return
    }

    // 用户重新入群时，取消旧的「等待结束后重新验证」定时器
    utils.cancelReverify(guildId, userId)

    // 网页验证模式：进群先禁言（默认 30 天），发提示 + 跳转按钮，让用户去网页做题
    if (config.verifyMode === 'web' && web?.isReady()) {
      logger.info(`开始对用户 ${userId} 进行网页验证`)
      await web.startWebVerify({
        guildId,
        platform,
        userId,
        bot: session.bot,
        send: (content) => session.send(content) as any,
      })
      return
    }

    // 开始验证
    logger.info(`开始对用户 ${userId} 进行入群验证`)
    await utils.startVerifyAndWatch(utils.targetOf(session))
  })

  // ==================== 群成员减少事件 ====================
  ctx.on('guild-member-removed', async (session) => {
    const { guildId, userId } = session

    // 清掉待执行的重新验证
    utils.cancelReverify(guildId, userId)

    // 如果用户正在验证中，清理会话
    if (verifier.isVerifying(guildId, userId)) {
      verifier.removeSession(guildId, userId)
      logger.info(`用户 ${userId} 主动退群，验证流程结束`)

      await session.send(config.messages.memberLeft)
    }

    // 数据库里的 pending 记录也一起结掉，避免重启后又把这个已经退群的人捞出来验证
    await db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.EXPIRED)
  })

  // ==================== QQ 按钮点击（平台推送 INTERACTION_CREATE） ====================
  // 适配器（如 qq-crack）把 INTERACTION_CREATE 转成 `interaction/button` 会话，
  // 按钮上带的 data 在 session.event.button.data 里。
  // 按钮全是**回调按钮**（action.type = 2），点了群里不会多发一条「指令消息」。
  // 只有「正在验证的本人」点了才有反应，其他人点了完全没动静。
  ctx.on('interaction/button' as any, async (session: any) => {
    const buttonData = typeof session?.event?.button?.data === 'string' ? session.event.button.data : ''

    // 不是本插件的按钮，交给别的插件
    if (!buttonData.startsWith(BUTTON_PREFIX)) return
    // 只处理群里的点击
    if (!session.guildId || session.isDirect) return

    const guildId: string = session.guildId
    // 回调事件自带「点按钮的人」的 id，只有这个人被认出来才继续
    const userId = resolveClickUserId(session)

    if (!userId) {
      logger.warn(`[interaction/button] 群 ${guildId} 的点击事件没有带上用户 id，忽略`)
      return
    }

    logger.info(`[interaction/button] 群 ${guildId} 点击者 ${userId} 点了 ${session.event?.button?.id ?? '?'} data=${buttonData}`)

    // 只认「正在验证的这个人」：点击者的 id 必须和验证会话里的 userId 对上，
    // 其他人（包括已经通过/已经超时/路过的群友）点了完全没反应
    if (!verifier.isVerifying(guildId, userId)) {
      logger.info(`点击者 ${userId} 不在验证中，忽略按钮点击`)
      return
    }

    const target = utils.targetOf(session, userId)
    const groupConfig = await verifier.getGroupConfig(guildId)

    // === 区域代号按钮（A1 / B2 …）===
    const regionCode = parseRegionButtonData(buttonData)
    if (regionCode) {
      // 简单模式点一下就是一次作答（扣次数），冷却久一点；困难模式只是选中，冷却短
      if (!utils.allowClick(guildId, userId, groupConfig.hardMode ? 'pick' : 'answer', groupConfig.hardMode ? 250 : 800)) {
        return
      }

      if (groupConfig.hardMode) {
        // 困难模式要答出全部区域：先点选累积，最后点「提交答案」
        const picks = verifier.addPick(guildId, userId, regionCode) ?? []
        await target.send([
          h.at(userId),
          h.text(`\n已选择：${picks.join('、') || '（无）'}\n点「✅ 提交答案」提交，点「🧹 清空」重选~`),
        ])
        return
      }

      // 简单模式：点哪个就按哪个判
      logger.info(`用户 ${userId} 点击按钮作答：${regionCode}`)
      const result = await verifier.checkAnswer(guildId, userId, regionCode)
      await utils.handleAnswerResult(target, result)
      return
    }

    if (buttonData === BUTTON_SUBMIT) {
      if (!utils.allowClick(guildId, userId, 'submit', 800)) return

      const picks = verifier.getPicks(guildId, userId)
      if (!picks.length) {
        await target.send([h.at(userId), h.text('\n还没选区域呢，先点上面的区域代号按钮吧~')])
        return
      }

      logger.info(`用户 ${userId} 提交已选区域：${picks.join(',')}`)
      const result = await verifier.checkAnswer(guildId, userId, picks.join(','))
      await utils.handleAnswerResult(target, result)
      return
    }

    if (buttonData === BUTTON_CLEAR) {
      if (!utils.allowClick(guildId, userId, 'clear', 250)) return

      verifier.clearPicks(guildId, userId)
      await target.send([h.at(userId), h.text('\n已清空已选区域，重新点选吧~')])
    }
  })

  // ==================== 群消息监听（答题） ====================
  ctx.middleware(async (session, next) => {
    // 只处理群消息
    if (!session.guildId || session.isDirect) {
      return next()
    }

    const { guildId, userId, messageId } = session

    // 检查是否在验证中
    const verifySession = verifier.getSession(guildId, userId)
    if (!verifySession) {
      return next()
    }

    // 提取纯文本答案
    const textContent = h.select(session.elements, 'text')
      .map((el) => el.attrs.content)
      .join('')
      .trim()

    if (!textContent) {
      return next()
    }

    // 验证答案
    const result = await verifier.checkAnswer(guildId, userId, textContent)

    await utils.handleAnswerResult(utils.targetOf(session), result, {
      recallUserMessage: config.recallWrongAnswer
        ? () => utils.recallMessage(session, messageId)
        : undefined,
    })

    // 不调用 next()，拦截这条消息
  }, true) // true 表示前置中间件

  return utils
}
