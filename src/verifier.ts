import { Context, Logger, h } from 'koishi'
import { Config, VerifyType, VerifySession, VerifyStatus, GroupConfig } from './types'
import { DatabaseService } from './database'
import { buildMarkdownImage, imageDataUri, isMarkdownImagePlatform, base64ToBuffer } from './markdown-image'
import { regionButton, submitButton, clearButton, parseButtonRegions } from './qq-button'
import { detectRegionLabels } from './grid-detect'

/** 识别不出网格时的兜底区域代号（A–E 列 × 1–3 行） */
const DEFAULT_BUTTON_REGIONS = 'A1,A2,A3,B1,B2,B3,C1,C2,C3,D1,D2,D3,E1,E2,E3'

const logger = new Logger('chiral-carbon-verifier:verifier')

/** 模板渲染：将 {key} 替换为对应变量值 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`))
}

/** 根据正确答案推断区域代号格式，用于从用户回复中提取代号 */
function buildRegionPattern(correctRegions: string[]): RegExp {
  const codes = correctRegions.map(r => r.trim().toUpperCase()).filter(Boolean)
  // 纯数字代号（如 1、2、3）
  if (codes.length > 0 && codes.every(r => /^\d+$/.test(r))) return /\d+/g
  // 纯字母代号（如 A、B、C）
  if (codes.length > 0 && codes.every(r => /^[A-Z]+$/.test(r))) return /[A-Z]+/g
  // 字母 + 数字（如 A1、B2），可兼容连写（A1A2A3B1 → A1 / A2 / A3 / B1）
  if (codes.length > 0 && codes.every(r => /^[A-Z]+\d+$/.test(r))) return /[A-Z]+\d+/g
  // 兜底：混合格式
  return /[A-Z]+\d+|\d+|[A-Z]+/g
}

/**
 * 解析用户回答中的区域代号
 * 支持：逗号 / 中文逗号 / 顿号 / 空格 / 分号 / 斜杠分隔，以及直接连写（A1A2A3B1）
 * 返回值已大写、去重
 */
export function parseUserRegions(input: string, correctRegions: string[]): string[] {
  const text = (input ?? '').toUpperCase()
  const tokens = text.match(buildRegionPattern(correctRegions)) ?? []
  return Array.from(new Set(tokens.map(t => t.trim()).filter(Boolean)))
}

/** 文案里的超时描述：verifyTimeout = 0 时是「不限时间」 */
export function timeoutText(verifyTimeout: number): string {
  return verifyTimeout > 0 ? `${verifyTimeout} 秒` : '不限时间'
}

/** 手性碳 API 响应类型 */
interface CarbonApiResponse {
  code?: number
  data?: {
    data?: {
      base64: string
      regions: string[]
    }
  }
}

/** 验证器核心类 */
export class Verifier {
  /** 活跃的验证会话 Map<guildId_userId, VerifySession> */
  private sessions = new Map<string, VerifySession>()

  constructor(
    private ctx: Context,
    private config: Config,
    private db: DatabaseService
  ) {}

  /** 生成会话 key */
  private getSessionKey(guildId: string, userId: string): string {
    return `${guildId}_${userId}`
  }

  /** 获取群配置（优先数据库配置，其次全局配置） */
  async getGroupConfig(guildId: string): Promise<{
    enabled: boolean
    useCarbonMode: boolean
    hardMode: boolean
    showHint: boolean
  }> {
    // 先查配置项中的群配置
    const configGroup = this.config.groupConfigs.find(g => g.guildId === guildId)
    if (configGroup) {
      return configGroup
    }

    // 再查数据库中的群配置
    const dbConfig = await this.db.getGroupConfig(guildId)
    if (dbConfig) {
      return dbConfig
    }

    // 返回默认配置
    return {
      enabled: this.config.enabled,
      useCarbonMode: true,
      hardMode: false,
      showHint: true,
    }
  }

  /** 检查用户是否为主人 */
  isMaster(platform: string, userId: string): boolean {
    return this.config.masterAccounts.some(
      m => m.enabled && m.platform === platform && m.userId === userId
    )
  }

  /** 检查用户是否正在验证中 */
  isVerifying(guildId: string, userId: string): boolean {
    return this.sessions.has(this.getSessionKey(guildId, userId))
  }

  /** 获取验证会话 */
  getSession(guildId: string, userId: string): VerifySession | undefined {
    return this.sessions.get(this.getSessionKey(guildId, userId))
  }

  /** 删除验证会话 */
  removeSession(guildId: string, userId: string): void {
    this.sessions.delete(this.getSessionKey(guildId, userId))
  }

  /** 开始验证流程 */
  async startVerify(
    guildId: string,
    userId: string,
    platform: string
  ): Promise<{
    success: boolean
    type: VerifyType
    message: h[]
    /** markdown 消息发不出去时的兜底消息（普通图片段） */
    fallbackMessage?: h[]
    imageBase64?: string
  }> {
    const key = this.getSessionKey(guildId, userId)
    const groupConfig = await this.getGroupConfig(guildId)

    // 如果已有会话，先删除
    if (this.sessions.has(key)) {
      this.sessions.delete(key)
    }

    const now = Date.now()
    // verifyTimeout = 0 表示不限时：expiresAt 记 0，也不会有超时定时器
    const expiresAt = this.config.verifyTimeout > 0 ? now + this.config.verifyTimeout * 1000 : 0

    // 尝试使用手性碳验证
    if (groupConfig.useCarbonMode) {
      try {
        const carbonResult = await this.fetchCarbonQuestion(groupConfig.showHint)
        
        if (carbonResult) {
          const session: VerifySession = {
            guildId,
            userId,
            type: VerifyType.CARBON,
            answer: carbonResult.regions,
            attempts: 0,
            createdAt: now,
            expiresAt,
            imageBase64: carbonResult.base64,
            picks: [],
          }
          this.sessions.set(key, session)

          // 持久化验证状态（重启后靠这条 pending 记录恢复，见 EventUtils.resumePending）
          await this.db.startVerifyRecord({
            guildId,
            userId,
            platform,
            type: VerifyType.CARBON,
            createdAt: now,
            expiresAt,
          })

          const regionCount = carbonResult.regions.length
          const modeHint = groupConfig.hardMode
            ? '全部含有手性碳的区域'
            : '其中任意一块包含手性碳的区域'

          const promptText = renderTemplate(this.config.messages.carbonPrompt, {
            timeout: this.config.verifyTimeout,
            timeoutText: timeoutText(this.config.verifyTimeout),
            modeHint,
            regionCount,
          })

          // 普通图片段：OneBot 等平台直发，同时作为 QQ markdown 发不出去时的兜底
          const plainMessage: h[] = [
            h.at(userId),
            h.text('\n'),
            h.image(imageDataUri(carbonResult.base64)),
            h.text('\n' + promptText),
          ]

          // QQ 平台：题目图必须走 markdown（普通图片会被二次压缩糊掉，官方 bot 也只认 md 里的图）
          if (this.config.qqMarkdownImage && isMarkdownImagePlatform(platform)) {
            const mdImage = await this.tryBuildMarkdownImage(carbonResult.base64)
            if (mdImage) {
              return {
                success: true,
                type: VerifyType.CARBON,
                imageBase64: carbonResult.base64,
                message: [
                  h.at(userId),
                  h('markdown', {}, `${mdImage.markdown}\n\n${promptText}`),
                  // QQ 上再带一组回调按钮：点区域代号即作答（只有本人点了才有反应）
                  ...(this.config.verifyButtons
                    ? this.buildRegionButtons(this.resolveRegionLabels(carbonResult.base64), [], groupConfig.hardMode)
                    : []),
                ],
                fallbackMessage: plainMessage,
              }
            }
          }

          return {
            success: true,
            type: VerifyType.CARBON,
            imageBase64: carbonResult.base64,
            message: plainMessage,
          }
        }
      } catch (error) {
        logger.warn('手性碳 API 请求失败，降级为数字验证:', error)
      }
    }

    // 降级为数字验证
    return this.startMathVerify(guildId, userId, platform, now, expiresAt)
  }

  /** 开始数字验证 */
  private async startMathVerify(
    guildId: string,
    userId: string,
    platform: string,
    now: number,
    expiresAt: number
  ): Promise<{
    success: boolean
    type: VerifyType
    message: h[]
  }> {
    const key = this.getSessionKey(guildId, userId)
    
    // 生成数学题
    const a = Math.floor(Math.random() * 100)
    const b = Math.floor(Math.random() * 100)
    const op = Math.random() > 0.5 ? '+' : '-'
    const answer = op === '+' ? a + b : a - b

    const session: VerifySession = {
      guildId,
      userId,
      type: VerifyType.MATH,
      answer,
      attempts: 0,
      createdAt: now,
      expiresAt,
    }
    this.sessions.set(key, session)

    // 持久化验证状态（重启后靠这条 pending 记录恢复）
    await this.db.startVerifyRecord({
      guildId,
      userId,
      platform,
      type: VerifyType.MATH,
      createdAt: now,
      expiresAt,
    })

    return {
      success: true,
      type: VerifyType.MATH,
      message: [
        h.at(userId),
        h.text('\n' + renderTemplate(this.config.messages.mathPrompt, {
          timeout: this.config.verifyTimeout,
          timeoutText: timeoutText(this.config.verifyTimeout),
          expression: `${a} ${op} ${b}`,
        })),
      ],
    }
  }

  /**
   * 题目消息里的按钮组：候选区域代号（点一下=选中/作答）+ 提交/清空（困难模式）
   * 全部是**回调按钮**（action.type = 1），点了只回调后台，不会发指令、也不会刷屏。
   */
  buildRegionButtons(labels: string[], picks: string[] = [], hardMode = false): h[] {
    if (!labels.length) return []

    const buttons: h[] = labels.map((code) => regionButton(code, picks.includes(code)))

    // 困难模式要一次答对全部区域：先点选累积，再点「提交答案」
    if (hardMode) {
      buttons.push(submitButton())
      if (picks.length) buttons.push(clearButton())
    }

    return buttons
  }

  /**
   * 按钮上要摆哪些区域代号：
   * - `buttonRegions = auto`（默认）：**从题目图里数格子**——图上按棋盘格配色（相邻格子异色、斜对角同色，
   *   也就是 A1 与 B2 同色、B1 与 A2 同色），套不同行列数看哪种切分最自洽，就能得出 5 列 × 3 行 → A1…E3；
   * - 配置里写了具体代号：直接用配置的；
   * - 识别失败：退回配置/默认的 A1…E3。
   */
  private resolveRegionLabels(base64: string): string[] {
    const configured = (this.config.buttonRegions ?? '').trim()
    const isAuto = !configured || /^auto$/i.test(configured)

    if (!isAuto) return parseButtonRegions(configured)

    try {
      const buffer = base64ToBuffer(base64)
      const labels = buffer ? detectRegionLabels(buffer) : null
      if (labels?.length) {
        logger.info(`从题目图识别到 ${labels.length} 个区域格子（${labels[0]} … ${labels[labels.length - 1]}）`)
        return labels
      }
      logger.warn('题目图网格识别失败，退回配置里的默认区域代号')
    } catch (error) {
      logger.warn('题目图网格识别异常，退回配置里的默认区域代号:', error)
    }

    return parseButtonRegions(DEFAULT_BUTTON_REGIONS)
  }

  /** 点选一个区域（困难模式累积，简单模式也是走这个再立即提交） */
  addPick(guildId: string, userId: string, code: string): string[] | null {
    const session = this.getSession(guildId, userId)
    if (!session) return null

    const normalized = code.trim().toUpperCase()
    const picks = session.picks ?? []
    if (!picks.includes(normalized)) picks.push(normalized)
    session.picks = picks
    return [...picks]
  }

  /** 清空已选区域 */
  clearPicks(guildId: string, userId: string): string[] | null {
    const session = this.getSession(guildId, userId)
    if (!session) return null
    session.picks = []
    return []
  }

  /** 取已选区域 */
  getPicks(guildId: string, userId: string): string[] {
    return this.getSession(guildId, userId)?.picks ?? []
  }

  /**
   * 把 API 返回的题目图转成 QQ markdown 图片片段。
   * 拿不到公网地址 / 读不出尺寸 / 没装 assets 服务时返回 null，调用方退回普通图片段。
   */
  private async tryBuildMarkdownImage(base64: string) {
    try {
      const result = await buildMarkdownImage(this.ctx, base64, this.config.markdownImageWidth)
      if (!result) {
        logger.warn('QQ markdown 图片生成失败（没装 assets 服务 / 上传失败 / 读不出图片尺寸），本次退回普通图片发送')
      }
      return result
    } catch (error) {
      logger.warn('QQ markdown 图片生成异常，本次退回普通图片发送:', error)
      return null
    }
  }

  /** 请求手性碳题目 */
  private async fetchCarbonQuestion(showHint: boolean): Promise<{
    base64: string
    regions: string[]
  } | null> {
    try {
      const response = await this.ctx.http.post<any>(
        `${this.config.carbonApiUrl}/captcha/chiralCarbon/getChiralCarbonCaptcha`,
        {
          answer: true,
          hint: showHint,
        },
        {
          timeout: this.config.apiTimeout,
        }
      )

      // 响应格式: { status, code, message, data: { data: { regions, base64 } } }
      // koishi http 返回的是 body，所以是 response.data.xxx
      const carbonData = response?.data?.data || response?.data
      if (carbonData?.base64 && carbonData?.regions) {
        // base64 可能包含 data:image/png;base64, 前缀，需要处理
        let base64Str = carbonData.base64 as string
        if (base64Str.startsWith('data:')) {
          base64Str = base64Str.split(',')[1] || base64Str
        }
        return {
          base64: base64Str,
          regions: carbonData.regions as string[],
        }
      }

      logger.warn('手性碳 API 返回格式异常:', response)
      return null
    } catch (error) {
      logger.error('手性碳 API 请求失败:', error)
      throw error
    }
  }

  /** 验证答案 */
  async checkAnswer(
    guildId: string,
    userId: string,
    userAnswer: string
  ): Promise<{
    correct: boolean
    passed: boolean
    failed: boolean
    remainingAttempts: number
    message: string
  }> {
    const session = this.getSession(guildId, userId)
    
    if (!session) {
      return {
        correct: false,
        passed: false,
        failed: false,
        remainingAttempts: 0,
        message: '你没有正在进行的验证',
      }
    }

    session.attempts++
    const remainingAttempts = this.config.maxAttempts - session.attempts

    let correct = false

    if (session.type === VerifyType.MATH) {
      // 数字验证
      const num = parseInt(userAnswer.trim(), 10)
      correct = !isNaN(num) && num === session.answer
    } else {
      // 手性碳验证
      const groupConfig = await this.getGroupConfig(guildId)

      const correctRegions = Array.from(new Set(
        (session.answer as string[]).map(r => r.trim().toUpperCase()).filter(Boolean)
      ))
      const userRegions = parseUserRegions(userAnswer, correctRegions)

      // 答案里是否混入了错误区域（如正确答案只有 A1，却发 A1A2A3B1）
      const wrongRegions = userRegions.filter(r => !correctRegions.includes(r))
      // 是否漏答了正确区域
      const missingRegions = correctRegions.filter(r => !userRegions.includes(r))

      if (userRegions.length === 0) {
        // 没有解析出任何区域代号，直接判错
        correct = false
      } else if (wrongRegions.length > 0) {
        // 只要混入错误区域就直接拒绝，避免「多写几个总有一个中」的枚举作弊
        correct = false
      } else if (groupConfig.hardMode) {
        // 困难模式：需要答出所有区域
        correct = missingRegions.length === 0
      } else {
        // 简单模式：答对任意一个即可（但答案里不能有错误区域）
        correct = userRegions.length > 0
      }
    }

    if (correct) {
      // 验证通过
      this.removeSession(guildId, userId)
      await this.db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.PASSED, session.attempts)
      
      return {
        correct: true,
        passed: true,
        failed: false,
        remainingAttempts,
        message: this.config.messages.verifyPass,
      }
    }

    if (remainingAttempts <= 0) {
      // 验证失败
      this.removeSession(guildId, userId)

      // 禁言模式下面还要重新验证，记录得继续 pending（等 events 写入禁言到期时间）
      if (this.config.failAction === 'ban') {
        await this.db.updateVerifyRecordAttempts(guildId, userId, session.attempts)
      } else {
        await this.db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.FAILED, session.attempts)
      }
      
      return {
        correct: false,
        passed: false,
        failed: true,
        remainingAttempts: 0,
        message: this.config.messages.verifyFail,
      }
    }

    // 还有机会
    return {
      correct: false,
      passed: false,
      failed: false,
      remainingAttempts,
      message: renderTemplate(this.config.messages.wrongAnswer, { remaining: remainingAttempts }),
    }
  }

  /** 处理验证超时 */
  async handleTimeout(guildId: string, userId: string): Promise<void> {
    const session = this.getSession(guildId, userId)
    if (session) {
      this.removeSession(guildId, userId)

      // 同样是禁言模式：记录保持 pending，等重新验证
      if (this.config.failAction === 'ban') {
        await this.db.updateVerifyRecordAttempts(guildId, userId, session.attempts)
      } else {
        await this.db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.EXPIRED, session.attempts)
      }
    }
  }

  /** 绕过验证 */
  async bypassVerify(guildId: string, userId: string): Promise<void> {
    this.removeSession(guildId, userId)
    // 如果有 pending 记录，标记为通过
    await this.db.updateVerifyRecordStatus(guildId, userId, VerifyStatus.PASSED, 0)
  }
}
