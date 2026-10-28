import { Context, Logger, h } from 'koishi'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { Config, VerifyStatus, VerifyType, VerifyRecord } from './types'
import { DatabaseService } from './database'
import { Verifier } from './verifier'
import { linkButton } from './qq-button'

const logger = new Logger('chiral-carbon-verifier:web')

/** 网页里缓存的题目（每用户一份，10 分钟没动就丢） */
interface WebQuestion {
  type: VerifyType
  imageBase64?: string
  regions?: string[]
  expression?: string
  answer?: number
  prompt: string
  createdAt: number
}

/** 题目缓存有效期：10 分钟（刷新页面沿用同一道题） */
const QUESTION_TTL = 10 * 60 * 1000

/**
 * 网页验证：
 * - 进群**静默**禁言（默认 30 天），群里只发一条链接（QQ 上带跳转按钮），其它什么都不发
 * - 网页里显示题目和选项，所有提示（答错剩几次 / 冷却 / 通过）都在网页里
 * - 答对自动解除禁言
 * - 页面**独占一个端口**（配置 `webPort`），和 koishi 主端口互不影响
 */
export class WebVerifier {
  private questions = new Map<string, WebQuestion>()
  private server?: Server<typeof IncomingMessage, typeof ServerResponse>

  constructor(
    private ctx: Context,
    private config: Config,
    private db: DatabaseService,
    private verifier: Verifier
  ) {}

  /** 对外地址：`<webServer>/<openid>`（webServer 里应包含端口，走反代则填域名） */
  buildUrl(userId: string): string {
    const base = (this.config.webServer ?? '').trim().replace(/\/+$/, '')
    return `${base}/${encodeURIComponent(userId)}`
  }

  /** 配置是否可用（没填服务器地址就没法做网页验证） */
  isReady(): boolean {
    const base = (this.config.webServer ?? '').trim()
    if (!/^https?:\/\//i.test(base)) {
      logger.warn('网页验证需要先在配置里填写「服务器地址」（如 https://verify.example.com:5140），本次退回群内作答')
      return false
    }
    return true
  }

  /** 禁言时长（分钟）：默认 30 天 */
  get banMinutes(): number {
    return Math.max(1, Math.round(this.config.webBanMinutes ?? 43200))
  }

  /** 监听端口 */
  get port(): number {
    return Math.max(1, Math.round(this.config.webPort ?? 5140))
  }

  // ==================== 入群：静默禁言 + 只发链接 ====================

  /**
   * 网页验证模式的入群处理（**静默**）：
   * 1. 先禁言（默认 30 天，验证通过自动解禁，防广告）
   * 2. 建一条 pending 记录（重启后靠它继续认人）
   * 3. 群里**只发一条链接消息**（QQ 上带一个跳转按钮），不 @ 人、不提示、不刷屏；
   *    后续所有提示（答错剩几次、冷却、通过）全部在网页里显示。
   */
  async startWebVerify(target: {
    guildId: string
    platform: string
    userId: string
    send: (content: h[]) => Promise<string[] | null>
    bot: any
  }): Promise<boolean> {
    const { guildId, userId, platform } = target

    const muted = await this.mute(target, this.banMinutes)
    const now = Date.now()

    await this.db.startVerifyRecord({
      guildId,
      userId,
      platform,
      type: VerifyType.CARBON,
      createdAt: now,
      expiresAt: now + this.banMinutes * 60 * 1000,
    })

    const url = this.buildUrl(userId)
    const isQQ = /^qq(bot)?(-|$)/i.test(platform)

    // 只发链接：QQ 上给一个跳转按钮（点了直接开网页），其它平台就是纯链接
    const message: h[] = isQQ && this.config.verifyButtons
      ? [linkButton(url, '🌐 点我验证'), h.text(url)]
      : [h.text(url)]

    const ids = await target.send(message)
    if (!ids) {
      logger.error(`向用户 ${userId} 发送网页验证链接失败`)
      return false
    }

    logger.info(
      `用户 ${userId} 已进入网页验证（禁言 ${this.banMinutes} 分钟）：${url}` +
        (muted ? '' : '（禁言失败，可能没管理员权限）')
    )
    return true
  }

  /** 禁言 / 解禁（minutes = 0 表示解禁） */
  async mute(target: { guildId: string; userId: string; bot: any }, minutes: number): Promise<boolean> {
    const seconds = minutes <= 0 ? 0 : Math.max(60, Math.round(minutes * 60))

    try {
      const internal = target.bot?.internal
      if (internal?.setGroupBan) {
        await internal.setGroupBan(target.guildId, target.userId, seconds)
        return true
      }

      const api = target.bot as any
      if (typeof api.muteGuildMember === 'function') {
        await api.muteGuildMember(target.guildId, target.userId, seconds * 1000)
        return true
      }

      logger.warn(`无法${minutes > 0 ? '禁言' : '解禁'}用户 ${target.userId}，当前适配器不支持`)
      return false
    } catch (error) {
      logger.error(`${minutes > 0 ? '禁言' : '解禁'}用户 ${target.userId} 失败:`, error)
      return false
    }
  }

  // ==================== 独立端口的 HTTP 服务 ====================

  /** 启动网页服务（独占配置里的端口） */
  apply(): void {
    if (this.server) return

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        logger.error('处理网页验证请求失败:', error)
        try {
          if (!res.headersSent) this.sendHtml(res, 500, this.simplePage('500', '服务器出错了，请稍后再试'))
          else res.end()
        } catch {}
      })
    })

    server.on('error', (error: any) => {
      if (error?.code === 'EADDRINUSE') {
        logger.error(`网页验证端口 ${this.port} 已被占用，请改配置里的「网页验证端口」`)
      } else {
        logger.error(`网页验证服务启动失败（端口 ${this.port}）:`, error)
      }
    })

    server.listen(this.port, () => {
      logger.info(`网页验证服务已启动：监听 ${this.port} 端口（访问地址 = 配置的服务器地址 + /openid）`)
    })

    this.server = server
  }

  /** 关掉端口（插件卸载 / 重载时） */
  stop(): void {
    if (!this.server) return
    this.server.close()
    this.server = undefined
    logger.info('网页验证服务已关闭')
  }

  /** 统一处理请求：只接管 `/openid` 这种单段路径 */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/'
    const index = rawUrl.indexOf('?')
    const pathname = index >= 0 ? rawUrl.slice(0, index) : rawUrl
    const search = new URLSearchParams(index >= 0 ? rawUrl.slice(index + 1) : '')

    const match = /^\/([A-Za-z0-9_-]{6,64})\/?$/.exec(pathname)
    if (!match) {
      this.sendHtml(res, 404, this.simplePage('🤔 页面不存在', '验证地址应该长这样：<code>服务器地址/openid</code>'))
      return
    }

    const opid = match[1]
    const guildId = search.get('g') ?? undefined

    if (req.method === 'POST') {
      const form = await readForm(req)
      const answer = String(form.answer ?? form.a ?? form.input ?? '').trim()
      const formGuild = String(form.g ?? '') || guildId
      await this.handleSubmit(opid, formGuild, answer, res)
      return
    }

    await this.handlePage(opid, guildId, res)
  }

  /** HTML 响应 */
  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(html)
  }

  /** 挑出这个 openid 当前要处理的那条记录 */
  private async resolveRecord(userId: string, guildId?: string): Promise<VerifyRecord | undefined> {
    const records = await this.db.getPendingWebRecords(userId)
    if (!records.length) return undefined
    if (guildId) return records.find((r) => r.guildId === guildId) ?? records[0]
    return records[records.length - 1]
  }

  /** GET：打开验证页面 */
  private async handlePage(opid: string, guildId: string | undefined, res: ServerResponse): Promise<void> {
    const record = await this.resolveRecord(opid, guildId)
    const now = Date.now()

    // 冷却中
    const notBefore = Number(record?.notBefore ?? 0)
    if (record && notBefore > now) {
      const minutes = Math.ceil((notBefore - now) / 60000)
      this.sendHtml(res, 200, this.simplePage('⏳ 冷却中', `你答错太多次啦，请 <b>${minutes}</b> 分钟后再打开本页面重试。`))
      return
    }

    if (!record) {
      // 没有待验证记录：可能已经通过了
      const history = await this.db.getWebRecordsByUser(opid)
      const passed = history.some((r) => r.status === VerifyStatus.PASSED)

      if (passed) {
        this.sendHtml(res, 200, this.simplePage('✅ 你已经通过验证了', '不用再答啦，去群里聊天吧~'))
      } else {
        this.sendHtml(
          res,
          404,
          this.simplePage(
            '🤔 没有待验证的题目',
            '<p>可能是下面几种情况：</p><ul><li>已经验证通过了</li><li>链接不对 / 已经过期</li>' +
              '<li>机器人刚重启，请稍等再试</li></ul><p>如果确实需要验证，请在群里 @ 管理员重新发起。</p>'
          )
        )
      }
      return
    }

    const question = await this.getQuestion(record.guildId, opid)
    const attempts = Number(record.webAttempts ?? 0)
    const left = Math.max(0, Math.max(1, this.config.webMaxAttempts) - attempts)

    this.sendHtml(res, 200, this.renderQuestionPage(record.guildId, question, left))
  }

  /** POST：提交答案 */
  private async handleSubmit(
    opid: string,
    guildId: string | undefined,
    answer: string,
    res: ServerResponse
  ): Promise<void> {
    const record = await this.resolveRecord(opid, guildId)

    if (!record) {
      this.sendHtml(res, 404, this.simplePage('🤔 没有待验证的题目', '可能已经验证通过，或者链接已失效。'))
      return
    }

    // 冷却中不接受提交
    const now = Date.now()
    const notBefore = Number(record.notBefore ?? 0)
    if (notBefore > now) {
      const minutes = Math.ceil((notBefore - now) / 60000)
      this.sendHtml(res, 200, this.simplePage('⏳ 冷却中', `请 <b>${minutes}</b> 分钟后再试。`))
      return
    }

    if (!answer) {
      this.sendHtml(
        res,
        200,
        this.simplePage('请先选择答案', `<p><a href="?g=${encodeURIComponent(record.guildId)}">← 返回题目</a></p>`)
      )
      return
    }

    const question = await this.getQuestion(record.guildId, opid)
    const correct = await this.verifier.checkWebAnswer(record.guildId, question, answer)
    const attempts = Number(record.webAttempts ?? 0) + 1
    const maxAttempts = Math.max(1, this.config.webMaxAttempts)

    // === 答对：解禁，群里不发消息 ===
    if (correct) {
      this.dropQuestion(record.guildId, opid)
      await this.db.passWebRecord(record.id, attempts)

      const bot = this.pickBot(record.platform)
      if (bot) {
        const unmuted = await this.mute({ guildId: record.guildId, userId: opid, bot }, 0)
        if (!unmuted) logger.warn(`用户 ${opid} 验证通过了，但解除禁言失败（可能没管理员权限）`)
      } else {
        logger.warn(`没有在线的 ${record.platform} 机器人，无法解除用户 ${opid} 的禁言`)
      }

      logger.info(`用户 ${opid} 网页验证通过（第 ${attempts} 次），已解除禁言`)
      this.sendHtml(res, 200, this.simplePage('✅ 验证通过', '已自动解除禁言，回群里玩吧~'))
      return
    }

    // === 次数用完：进入冷却 ===
    if (attempts >= maxAttempts) {
      this.dropQuestion(record.guildId, opid)
      const cooldownMs = Math.max(1, this.config.webCooldownMinutes) * 60 * 1000
      await this.db.setWebState(record.id, { webAttempts: 0, notBefore: Date.now() + cooldownMs })

      logger.info(`用户 ${opid} 用完了 ${maxAttempts} 次机会，冷却 ${this.config.webCooldownMinutes} 分钟`)
      this.sendHtml(
        res,
        200,
        this.simplePage(
          '😵 答错太多次了',
          `本轮 ${maxAttempts} 次机会已经用完，请 <b>${this.config.webCooldownMinutes}</b> 分钟后再打开本页面重试。`
        )
      )
      return
    }

    // === 答错但还有机会：换一道新题继续 ===
    await this.db.setWebState(record.id, { webAttempts: attempts })
    const left = Math.max(0, maxAttempts - attempts)
    logger.info(`用户 ${opid} 答错了（${answer}），还剩 ${left} 次`)

    const next = await this.getQuestion(record.guildId, opid)
    this.sendHtml(res, 200, this.renderQuestionPage(record.guildId, next, left, `回答错了呢，你还有 ${left} 次机会`))
  }

  /** 取 / 生成题目：10 分钟内沿用同一道题 */
  private async getQuestion(guildId: string, userId: string): Promise<WebQuestion> {
    const key = `${guildId}_${userId}`
    const cached = this.questions.get(key)

    if (cached && Date.now() - cached.createdAt < QUESTION_TTL) return cached

    const created = await this.verifier.createWebQuestion(guildId)
    const question: WebQuestion = { ...created, createdAt: Date.now() }
    this.questions.set(key, question)

    // 顺手清掉过期缓存
    for (const [cacheKey, item] of this.questions) {
      if (Date.now() - item.createdAt > QUESTION_TTL) this.questions.delete(cacheKey)
    }

    return question
  }

  /** 丢掉缓存的题目 */
  private dropQuestion(guildId: string, userId: string): void {
    this.questions.delete(`${guildId}_${userId}`)
  }

  /** 挑一个该平台在线的机器人 */
  private pickBot(platform: string): any {
    return (this.ctx.bots ?? []).find((bot) => bot.platform === platform)
  }

  // ==================== 页面渲染 ====================

  /** 题目页：题目图 + 区域代号选项 */
  private renderQuestionPage(
    guildId: string,
    question: WebQuestion,
    left: number,
    notice?: string
  ): string {
    const options = this.verifier.getRegionLabels()
    const isMath = question.type === VerifyType.MATH

    const answerArea = isMath
      ? `<div class="options">
          <input class="num" type="text" name="answer" inputmode="numeric" placeholder="输入计算结果" required>
        </div>
        <button class="submit" type="submit">提交答案</button>`
      : `<div class="options">
          ${options.map((code) => `<button class="opt" type="submit" name="answer" value="${code}">${code}</button>`).join('')}
        </div>
        <details>
          <summary>按钮点不动？手动输入区域代号</summary>
          <div class="options" style="margin-top:8px">
            <input class="num" type="text" name="answer" placeholder="例如 B2 或 B2,C2">
          </div>
          <button class="submit" type="submit">提交</button>
        </details>`

    return this.renderPage({
      title: '入群验证',
      body: `<div class="card">
<h1>🧪 入群验证</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}
<p class="prompt">${escapeHtml(question.prompt).replace(/\n/g, '<br>')}</p>
${question.imageBase64 && !isMath ? `<div class="pic"><img src="data:image/png;base64,${question.imageBase64}" alt="题目图片"></div>` : ''}
<form method="POST" action="?g=${encodeURIComponent(guildId)}">
  ${answerArea}
</form>
<p class="hint">剩余机会：<b>${left}</b> 次 ｜ 答错太多次会进入冷却</p>
</div>`,
    })
  }

  /** 简单提示页 */
  private simplePage(title: string, body: string): string {
    const cls = title.includes('✅') ? ' ok' : title.includes('😵') || title.includes('⏳') ? ' warn' : ''
    return this.renderPage({ title, body: `<div class="card${cls}"><h1>${escapeHtml(title)}</h1>${body}</div>` })
  }

  /** 页面骨架（内联样式，手机端友好，支持深色模式） */
  private renderPage(options: { title: string; body: string }): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 16px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f4f5f7; color: #1f2329;
    display: flex; justify-content: center;
  }
  .card { width: 100%; max-width: 560px; background: #fff; border-radius: 14px; padding: 18px; box-shadow: 0 2px 14px rgba(0,0,0,.07); }
  h1 { font-size: 19px; margin: 0 0 10px; }
  .prompt { color: #4a5057; font-size: 15px; margin: 0 0 12px; }
  .notice { background: #fff4e5; color: #9a5b00; border-radius: 8px; padding: 8px 10px; font-size: 14px; margin: 0 0 12px; }
  .pic img { width: 100%; height: auto; border-radius: 10px; display: block; margin: 0 0 14px; background: #fff; }
  .options { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 0 0 12px; }
  .opt { padding: 12px 0; border-radius: 10px; border: 1px solid #d6dae0; background: #f7f9fc; font-size: 15px; font-weight: 600; color: #1f2329; cursor: pointer; }
  .opt:active { background: #e8eefc; border-color: #3b7cf6; }
  .num { grid-column: 1 / -1; padding: 12px; border-radius: 10px; border: 1px solid #d6dae0; font-size: 16px; width: 100%; }
  .submit { width: 100%; padding: 12px; border: 0; border-radius: 10px; background: #3b7cf6; color: #fff; font-size: 16px; font-weight: 600; }
  .hint { color: #868d95; font-size: 13px; margin: 12px 0 0; }
  details { margin: 6px 0 0; }
  details summary { color: #6b7280; font-size: 13px; cursor: pointer; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 5px; }
  .ok h1 { color: #16a34a; }
  .warn h1 { color: #d97706; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8eb; }
    .card { background: #202329; box-shadow: none; }
    .opt { background: #2a2e36; border-color: #3a3f48; color: #e6e8eb; }
    .num { background: #2a2e36; border-color: #3a3f48; color: #e6e8eb; }
    .prompt { color: #b6bcc4; }
    .hint { color: #8b929b; }
  }
</style>
</head>
<body>
${options.body}
</body>
</html>`
  }
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 读 POST 表单（application/x-www-form-urlencoded） */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as any)
    size += buffer.length
    // 表单很小，超过 16KB 直接丢弃
    if (size > 16 * 1024) break
    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  return Object.fromEntries(new URLSearchParams(raw))
}
