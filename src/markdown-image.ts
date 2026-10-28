/**
 * QQ 平台发题目图片必须走 markdown —— 参考 kkk 插件 `compat/imageMarkdown.ts` + `compat/imageSize.ts`。
 *
 * ## 为什么
 * 1. QQ 官方 bot 的**普通图片消息**（image 段 → 适配器按 MEDIA 上传）在手机端会被二次压缩，
 *    分子结构图上的小字糊成一片；**markdown 里的图片不会被压**，字是清楚的。
 * 2. QQ 的 md 图片**必须写死尺寸** `![#宽px #高px](地址)`：不写尺寸手机端干脆不显示这张图；
 *    尺寸还必须和原图比例一致，否则被拉伸。所以尺寸从**图片二进制头**里读真实值（PNG/JPEG/GIF/WebP）。
 * 3. md 里的图片地址**必须是可公网访问的 http(s)**：base64、`data:`、本地路径、相对路径都不认
 *    （qq-crack 会把 `data:` 图片再转成 MEDIA 上传，等于白改）。所以图片要先过宿主 **assets 服务**
 *    上传，拿到公网地址 —— 这就是「QQ 发图需要依赖一个服务」的那部分。
 *    → 没装 assets、或上传失败、或读不出尺寸时，本模块返回 null，调用方**退回普通图片段**，
 *      绝不让消息发不出去，也绝不发一张手机上什么都不显示的 md 图片。
 *
 * 只在「认 markdown 图片」的平台上用（白名单，只有 QQ 官方 / qq-crack 系）：
 * OneBot 系（NapCat / Lagrange / go-cqhttp / Chronocat…）收到 md 只会显示成一串文字、图片全丢；
 * QQ 频道（qqguild）走另一套编码器，md 元素会被当纯文本发出去。
 * 写成**白名单**而不是黑名单：新协议端默认不发 md，最坏只是少点排版，不会变成一堆乱码。
 */
import { Context } from 'koishi'

export interface ImageSize {
  width: number
  height: number
}

const UNKNOWN: ImageSize = { width: 0, height: 0 }

/** PNG 魔数（8 字节） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const isPng = (buffer: Buffer): boolean =>
  buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)

const isJpeg = (buffer: Buffer): boolean =>
  buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8

const isGif = (buffer: Buffer): boolean =>
  buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'GIF'

const isWebp = (buffer: Buffer): boolean =>
  buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP'

/** JPEG：尺寸在 SOF0..SOF15 上，中间夹着不是 SOF 的段（0xC4/0xC8/0xCC 要跳过），得逐段跳着找 */
function readJpegSize(buffer: Buffer): ImageSize {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length <= 0) break
    offset += 2 + length
  }
  return UNKNOWN
}

/** WebP 三种头的写法完全不一样（VP8X / VP8L / VP8 ），少一种那类 WebP 就读不出尺寸 */
function readWebpSize(buffer: Buffer): ImageSize {
  const format = buffer.toString('latin1', 12, 16)
  if (format === 'VP8X') {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
  }
  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (format === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  return UNKNOWN
}

/** 从图片二进制头读真实像素尺寸（认不出返回 0，调用方按「尺寸未知」处理，别猜） */
export function readImageSize(buffer: Buffer): ImageSize {
  try {
    if (!buffer || !buffer.length) return UNKNOWN
    // PNG：IHDR 在固定偏移（8 魔数 + 4 长度 + 4 类型 = 16）
    if (isPng(buffer) && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (isJpeg(buffer)) return readJpegSize(buffer)
    if (isGif(buffer)) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    if (isWebp(buffer)) return readWebpSize(buffer)
    // 都不认：找 buffer 里的 PNG/JPEG 签名再试一次（有些图源自带前置数据）
    const pngAt = buffer.indexOf(PNG_MAGIC)
    if (pngAt > 0 && buffer.length >= pngAt + 24) {
      return { width: buffer.readUInt32BE(pngAt + 16), height: buffer.readUInt32BE(pngAt + 20) }
    }
    const jpegAt = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
    if (jpegAt > 0) return readJpegSize(buffer.subarray(jpegAt))
    return UNKNOWN
  } catch {
    // 截断的图片会让 readUInt* 抛 RangeError，当成「读不出」
    return UNKNOWN
  }
}

/** 按**真实比例**缩到目标宽度以内（不放大，只缩小）—— 不许拉伸的唯一出口 */
export function scaleToWidth(size: ImageSize, maxWidth: number): ImageSize {
  const width = Math.min(size.width, Math.max(1, Math.round(maxWidth)))
  return { width, height: Math.max(1, Math.round((size.height * width) / size.width)) }
}

/**
 * 能渲染 **markdown 图片**的平台（白名单）：
 * `qq` / `qqbot`，以及带后缀的（`qq-crack` 之类）。
 * `qqguild`、`onebot`、`napcat`、`satori`、`milky`、空串……一律不算。
 */
const MARKDOWN_IMAGE_PLATFORMS = /^qq(bot)?(-|$)/i

export function isMarkdownImagePlatform(platform: string): boolean {
  return MARKDOWN_IMAGE_PLATFORMS.test(String(platform ?? '').trim())
}

/** 把 `base64://` / `data:image/...;base64,` 两种写法读成 Buffer */
export function base64ToBuffer(src: string): Buffer | null {
  if (!src) return null
  try {
    if (src.startsWith('base64://')) return Buffer.from(src.slice('base64://'.length), 'base64')
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',')
      if (comma < 0) return null
      return Buffer.from(src.slice(comma + 1), 'base64')
    }
    // 其它情况按裸 base64 处理
    return Buffer.from(src, 'base64')
  } catch {
    return null
  }
}

/** 按二进制头认 mime（发给 assets 用；标错会让适配器按错格式处理） */
function mimeOfBuffer(buffer: Buffer): string {
  if (isPng(buffer)) return 'image/png'
  if (isJpeg(buffer)) return 'image/jpeg'
  if (isGif(buffer)) return 'image/gif'
  if (isWebp(buffer)) return 'image/webp'
  return 'image/png'
}

/** 上传到宿主 assets，拿到 QQ 能直接取的公网地址；没有 assets 服务就返回 null */
export async function uploadImage(ctx: Context, buffer: Buffer): Promise<string | null> {
  const assets: any = (ctx as any).assets
  if (!assets?.upload) {
    return null
  }
  const mime = mimeOfBuffer(buffer)
  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/gif' ? '.gif' : mime === 'image/webp' ? '.webp' : '.png'
  const uploaded: any = await assets.upload(`data:${mime};base64,${buffer.toString('base64')}`, `chiral-verify${ext}`)
  const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
  return url && /^https?:\/\//i.test(String(url)) ? String(url) : null
}

/**
 * 把 API 返回的 base64 转成 koishi 认的 `data:` URI（顺手按文件头纠正 mime）。
 * 普通图片段用它：`base64://` 这种写法已经被 koishi 标记为废弃了。
 */
export function imageDataUri(base64: string): string {
  const buffer = base64ToBuffer(base64)
  if (!buffer) return `data:image/png;base64,${base64}`
  return `data:${mimeOfBuffer(buffer)};base64,${buffer.toString('base64')}`
}

export interface MarkdownImage {  /** 可直接拼进 markdown 正文的图片片段：`![#宽px #高px](地址)` */
  markdown: string
  size: ImageSize
}

/**
 * 题目图片（API 返回的 base64）→ QQ markdown 图片片段。
 *
 * @param ctx 插件上下文（用 `ctx.assets` 上传，没装 assets 服务时返回 null）
 * @param base64 API 返回的图片（裸 base64 或 `data:` / `base64://` 写法都行）
 * @param maxWidth md 里的显示宽度上限（高度按真实比例算，绝不拉伸）
 * @returns 拿不到尺寸 / 上传失败 / 没装 assets → null（调用方退回普通图片段）
 */
export async function buildMarkdownImage(
  ctx: Context,
  base64: string,
  maxWidth = 420,
): Promise<MarkdownImage | null> {
  const buffer = base64ToBuffer(base64)
  if (!buffer || !buffer.length) return null

  const size = readImageSize(buffer)
  if (size.width <= 0 || size.height <= 0) return null

  const url = await uploadImage(ctx, buffer)
  if (!url) return null

  const scaled = scaleToWidth(size, maxWidth)
  return {
    markdown: `![#${scaled.width}px #${scaled.height}px](${url})`,
    size: scaled,
  }
}
