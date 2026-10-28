import { Context } from 'koishi'
import { VerifyRecord, VerifyStatus, VerifyType, GroupConfig } from './types'

/** 扩展数据库模型 */
export function extendDatabase(ctx: Context) {
  // 验证记录表
  // 注意：除了「历史记录」，这张表还承担**验证状态持久化**的职责 —— 重启后靠
  // status = pending 的记录把未完成的验证重新捞起来（见 EventUtils.resumePending）。
  ctx.model.extend('chiral_verify_records', {
    id: 'unsigned',
    guildId: 'string',
    userId: 'string',
    platform: 'string',
    type: 'string',
    attempts: 'unsigned',
    /** 连续失败轮数（用于禁言时长翻倍：1→2→4→8…） */
    failRounds: 'unsigned',
    status: 'string',
    createdAt: 'unsigned',
    /** 本次验证的过期时间戳（0 表示未知） */
    expiresAt: 'unsigned',
    /** 等待期结束时间戳：禁言到期后再重新发题目；0 表示没有等待期 */
    notBefore: 'unsigned',
    /** 网页验证：本轮已提交次数（用完进入冷却） */
    webAttempts: 'unsigned',
    completedAt: 'unsigned',
  }, {
    autoInc: true,
  })

  // 群配置表（持久化群单独设置）
  ctx.model.extend('chiral_group_configs', {
    id: 'unsigned',
    guildId: 'string',
    enabled: 'boolean',
    useCarbonMode: 'boolean',
    hardMode: 'boolean',
    showHint: 'boolean',
  }, {
    autoInc: true,
    unique: ['guildId'],
  })
}

/** 数据库操作类 */
export class DatabaseService {
  constructor(private ctx: Context) {}

  // ==================== 验证记录 ====================

  /** 取用户当前 pending 的记录 */
  async getPendingRecord(guildId: string, userId: string): Promise<VerifyRecord | undefined> {
    const records = await this.ctx.database.get('chiral_verify_records', {
      guildId,
      userId,
      status: VerifyStatus.PENDING,
    })
    return records.length > 0 ? records[records.length - 1] : undefined
  }

  /**
   * 开始（或重置）一次验证记录。
   *
   * 同一用户只保留**一条** pending 记录：旧的 pending 直接原地重置，
   * 否则「禁言 → 重新发题目」每轮都会多一条 pending，重启恢复时会重复捞人。
   */
  async startVerifyRecord(data: {
    guildId: string
    userId: string
    platform: string
    type: string
    createdAt: number
    expiresAt: number
  }): Promise<void> {
    const payload = {
      guildId: data.guildId,
      userId: data.userId,
      platform: data.platform,
      type: data.type,
      attempts: 0,
      status: VerifyStatus.PENDING,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      notBefore: 0,
      completedAt: 0,
    }

    const existing = await this.getPendingRecord(data.guildId, data.userId)
    if (existing) {
      // 原地重置：failRounds（翻倍计数）保留，禁言—重发题目算同一轮「拉锯」
      await this.ctx.database.set('chiral_verify_records', existing.id, payload)
      return
    }

    // 新记录：继承上一轮的失败轮数（同一波拉锯里失败次数要累加），通过过的重新算 0
    const failRounds = await this.inheritFailRounds(data.guildId, data.userId)
    await this.ctx.database.create('chiral_verify_records', { ...payload, failRounds })
  }

  /** 最近一条记录（不管状态） */
  private async getLatestRecord(guildId: string, userId: string): Promise<VerifyRecord | undefined> {
    const records = await this.ctx.database
      .select('chiral_verify_records')
      .where({ guildId, userId })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .execute()
    return records[0]
  }

  /**
   * 继承上一轮的失败轮数：
   * - 上一条是「通过」→ 0（说明是重新入群的正常用户，从基础时长开始）
   * - 上一条太久远（> 24 小时）→ 0
   * - 否则沿用（同一波验证里答错 → 禁言 → 再答错，时长要翻倍）
   */
  private async inheritFailRounds(guildId: string, userId: string): Promise<number> {
    const latest = await this.getLatestRecord(guildId, userId)
    if (!latest) return 0
    if (latest.status === VerifyStatus.PASSED) return 0
    if (Date.now() - Number(latest.createdAt ?? 0) > 24 * 60 * 60 * 1000) return 0
    return Number(latest.failRounds ?? 0)
  }

  /** 取连续失败轮数（优先 pending 记录，没有就取最近一条） */
  async getFailRounds(guildId: string, userId: string): Promise<number> {
    const record = (await this.getPendingRecord(guildId, userId)) ?? (await this.getLatestRecord(guildId, userId))
    return Number(record?.failRounds ?? 0)
  }

  /** 写入连续失败轮数 */
  async setFailRounds(guildId: string, userId: string, failRounds: number): Promise<void> {
    const record = (await this.getPendingRecord(guildId, userId)) ?? (await this.getLatestRecord(guildId, userId))
    if (!record) return
    await this.ctx.database.set('chiral_verify_records', record.id, { failRounds })
  }

  /** 只更新答题次数（验证失败但还要禁言重试时，记录保持 pending） */
  async updateVerifyRecordAttempts(guildId: string, userId: string, attempts: number): Promise<void> {
    const record = await this.getPendingRecord(guildId, userId)
    if (!record) return
    await this.ctx.database.set('chiral_verify_records', record.id, { attempts })
  }

  /** 更新验证记录状态（取当前 pending 的那条） */
  async updateVerifyRecordStatus(
    guildId: string,
    userId: string,
    status: VerifyStatus,
    attempts?: number
  ): Promise<void> {
    const record = await this.getPendingRecord(guildId, userId)
    if (!record) return

    await this.ctx.database.set('chiral_verify_records', record.id, {
      status,
      completedAt: Date.now(),
      notBefore: 0,
      ...(attempts !== undefined ? { attempts } : {}),
    })
  }

  /** 设置等待期（禁言到期时间戳）；重启后据此恢复定时器 */
  async setNotBefore(guildId: string, userId: string, notBefore: number): Promise<void> {
    const record = await this.getPendingRecord(guildId, userId)
    if (!record) return
    await this.ctx.database.set('chiral_verify_records', record.id, { notBefore })
  }

  /** 取所有未完成的验证记录（重启恢复用） */
  async getPendingRecords(): Promise<VerifyRecord[]> {
    return await this.ctx.database.get('chiral_verify_records', { status: VerifyStatus.PENDING })
  }

  // ==================== 网页验证专用 ====================

  /** 按 userId 找未完成的网页验证记录（网页地址里只有 openid，靠这个反查是哪个群） */
  async getPendingWebRecords(userId: string): Promise<VerifyRecord[]> {
    const records = await this.ctx.database.get('chiral_verify_records', {
      userId,
      type: VerifyType.CARBON,
      status: VerifyStatus.PENDING,
    })
    return records
  }

  /** 按 userId 找**任意状态**的网页验证记录（判断是不是「已验证通过」） */
  async getWebRecordsByUser(userId: string): Promise<VerifyRecord[]> {
    return await this.ctx.database
      .select('chiral_verify_records')
      .where({ userId })
      .orderBy('createdAt', 'desc')
      .limit(5)
      .execute()
  }

  /** 网页验证：记一次提交（次数 + 冷却时间） */
  async setWebState(recordId: number, state: { webAttempts?: number; notBefore?: number }): Promise<void> {
    await this.ctx.database.set('chiral_verify_records', recordId, state)
  }

  /** 网页验证通过：标记记录 + 清冷却 */
  async passWebRecord(recordId: number, attempts: number): Promise<void> {
    await this.ctx.database.set('chiral_verify_records', recordId, {
      status: VerifyStatus.PASSED,
      attempts,
      webAttempts: 0,
      notBefore: 0,
      completedAt: Date.now(),
    })
  }

  /** 获取用户验证历史 */
  async getUserVerifyHistory(
    guildId: string,
    userId: string,
    limit = 10
  ): Promise<VerifyRecord[]> {
    return await this.ctx.database
      .select('chiral_verify_records')
      .where({ guildId, userId })
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute()
  }

  /** 获取群验证统计 */
  async getGuildStats(guildId: string): Promise<{
    total: number
    passed: number
    failed: number
    expired: number
  }> {
    const records = await this.ctx.database.get('chiral_verify_records', { guildId })

    return {
      total: records.length,
      passed: records.filter(r => r.status === VerifyStatus.PASSED).length,
      failed: records.filter(r => r.status === VerifyStatus.FAILED).length,
      expired: records.filter(r => r.status === VerifyStatus.EXPIRED).length,
    }
  }

  /** 清理过期记录（可选，定期调用） */
  async cleanupOldRecords(beforeTimestamp: number): Promise<number> {
    const oldRecords = await this.ctx.database.get('chiral_verify_records', {
      createdAt: { $lt: beforeTimestamp },
    })

    if (oldRecords.length > 0) {
      await this.ctx.database.remove('chiral_verify_records', {
        createdAt: { $lt: beforeTimestamp },
      })
    }

    return oldRecords.length
  }

  // ==================== 群配置 ====================

  /** 获取群配置 */
  async getGroupConfig(guildId: string): Promise<GroupConfig | null> {
    const configs = await this.ctx.database.get('chiral_group_configs', { guildId })
    return configs.length > 0 ? configs[0] : null
  }

  /** 保存群配置 */
  async saveGroupConfig(config: GroupConfig): Promise<void> {
    const existing = await this.getGroupConfig(config.guildId)

    if (existing) {
      await this.ctx.database.set('chiral_group_configs', { guildId: config.guildId }, {
        enabled: config.enabled,
        useCarbonMode: config.useCarbonMode,
        hardMode: config.hardMode,
        showHint: config.showHint,
      })
    } else {
      await this.ctx.database.create('chiral_group_configs', config)
    }
  }

  /** 删除群配置 */
  async deleteGroupConfig(guildId: string): Promise<void> {
    await this.ctx.database.remove('chiral_group_configs', { guildId })
  }
}
