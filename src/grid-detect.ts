import { inflateSync } from 'node:zlib'

/**
 * 极简 PNG 解码（只用 node 自带的 zlib，不引第三方图像库）
 *
 * 目的：从题目图里**分析出网格有几行几列**，从而生成正确的区域代号按钮。
 * 支持 8/16 位深度的常见 PNG（灰度 / 真彩 / 调色板 / 带 alpha），不支持隔行扫描。
 */
export interface DecodedImage {
  width: number
  height: number
  /** RGBA，每像素 4 字节 */
  data: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 解码 PNG；不支持的格式返回 null（调用方退回配置里的固定代号列表） */
export function decodePng(buffer: Uint8Array): DecodedImage | null {
  if (buffer.length < 8) return null
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return null
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const idatChunks: Uint8Array[] = []

  while (offset + 8 <= buffer.length) {
    const length = readUInt32(buffer, offset)
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7])
    const dataStart = offset + 8
    const chunk = buffer.subarray(dataStart, dataStart + length)

    if (type === 'IHDR') {
      width = readUInt32(chunk, 0)
      height = readUInt32(chunk, 4)
      bitDepth = chunk[8]
      colorType = chunk[9]
      interlace = chunk[12]
    } else if (type === 'PLTE') {
      palette = chunk
    } else if (type === 'tRNS') {
      transparency = chunk
    } else if (type === 'IDAT') {
      idatChunks.push(chunk)
    } else if (type === 'IEND') {
      break
    }

    offset = dataStart + length + 4 // 跳过 CRC
  }

  if (!width || !height || !idatChunks.length) return null
  if (interlace !== 0) return null
  if (bitDepth !== 8 && bitDepth !== 16) return null

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const bytesPerSample = bitDepth / 8
  const bpp = channels * bytesPerSample
  const stride = width * bpp

  let raw: Uint8Array
  try {
    const compressed = Buffer.concat(idatChunks.map((chunk) => Buffer.from(chunk)))
    raw = new Uint8Array(inflateSync(compressed))
  } catch {
    return null
  }

  if (raw.length < (stride + 1) * height) return null

  // 反滤波
  const pixels = new Uint8Array(stride * height)
  let rawOffset = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++]
    const rowStart = y * stride
    const prevStart = rowStart - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset + x]
      const left = x >= bpp ? pixels[rowStart + x - bpp] : 0
      const up = y > 0 ? pixels[prevStart + x] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0

      let out: number
      switch (filter) {
        case 0:
          out = value
          break
        case 1:
          out = value + left
          break
        case 2:
          out = value + up
          break
        case 3:
          out = value + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          out = value + predictor
          break
        }
        default:
          return null
      }
      pixels[rowStart + x] = out & 0xff
    }

    rawOffset += stride
  }

  // 转 RGBA
  const data = new Uint8Array(width * height * 4)
  const sample = (rowStart: number, index: number) =>
    bitDepth === 16 ? pixels[rowStart + index * 2] : pixels[rowStart + index]

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4

      if (colorType === 3 && palette) {
        const index = pixels[rowStart + x]
        data[target] = palette[index * 3] ?? 0
        data[target + 1] = palette[index * 3 + 1] ?? 0
        data[target + 2] = palette[index * 3 + 2] ?? 0
        data[target + 3] = transparency?.[index] ?? 255
      } else if (colorType === 0 || colorType === 4) {
        const gray = sample(rowStart, x * channels)
        data[target] = data[target + 1] = data[target + 2] = gray
        data[target + 3] = colorType === 4 ? sample(rowStart, x * channels + 1) : 255
      } else {
        data[target] = sample(rowStart, x * channels)
        data[target + 1] = sample(rowStart, x * channels + 1)
        data[target + 2] = sample(rowStart, x * channels + 2)
        data[target + 3] = colorType === 6 ? sample(rowStart, x * channels + 3) : 255
      }
    }
  }

  return { width, height, data }
}

function readUInt32(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) >>> 0) +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
  )
}

/** 检测出的网格信息 */
export interface GridInfo {
  /** 列数 */
  cols: number
  /** 行数 */
  rows: number
  /** 按「先列后行」排好的区域代号：A1,A2,A3,B1,… */
  labels: string[]
  /** 棋盘格的两种底色（十六进制） */
  colors: [string, string]
  /** 匹配度 0~1 */
  confidence: number
}

/**
 * 从题目图里认出「有几行几列」。
 *
 * 原理就是图上那套**棋盘格配色**：相邻格子颜色不同、斜对角同色
 * （A1 和 B2 同色，B1 和 A2 同色），所以只要拿两种底色去套不同行列数，
 * 哪种切分能让「同奇偶的格子全是同一种颜色」就说明切对了。
 */
export function detectGrid(image: DecodedImage): GridInfo | null {
  const { width, height, data } = image

  // ===== 1. 找出两种格子底色（按量化后的颜色计数，取前两名）=====
  const buckets = new Map<number, number>()
  const step = Math.max(1, Math.round(Math.min(width, height) / 400))

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 200) continue
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
  }

  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
  if (top.length < 2) return null

  const toRgb = (key: number): [number, number, number] => [
    (key >> 8) * 17,
    ((key >> 4) & 0xf) * 17,
    (key & 0xf) * 17,
  ]
  const colorA = toRgb(top[0][0])
  const colorB = toRgb(top[1][0])

  // 两种颜色得真的不一样
  const colorDistance =
    Math.abs(colorA[0] - colorB[0]) + Math.abs(colorA[1] - colorB[1]) + Math.abs(colorA[2] - colorB[2])
  if (colorDistance < 12) return null

  // ===== 2. 把像素分成 A / B / 其他，并求出格子区域包围盒 =====
  const tolerance = 28
  const near = (r: number, g: number, b: number, c: [number, number, number]) =>
    Math.abs(r - c[0]) <= tolerance && Math.abs(g - c[1]) <= tolerance && Math.abs(b - c[2]) <= tolerance

  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1

  /** 0 = 颜色A，1 = 颜色B，-1 = 其他（线条、文字、抗锯齿） */
  const classify = (x: number, y: number): number => {
    const i = (y * width + x) * 4
    if (data[i + 3] < 200) return -1
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (near(r, g, b, colorA)) return 0
    if (near(r, g, b, colorB)) return 1
    return -1
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (classify(x, y) < 0) continue
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  if (x1 <= x0 || y1 <= y0) return null

  const gridWidth = x1 - x0 + 1
  const gridHeight = y1 - y0 + 1
  if (gridWidth < 40 || gridHeight < 40) return null

  // ===== 3. 采样（网格范围里均匀取点）=====
  const samplesX = Math.min(240, gridWidth)
  const samplesY = Math.min(240, gridHeight)
  const points: Array<{ u: number; v: number; c: number }> = []

  for (let sy = 0; sy < samplesY; sy++) {
    const y = y0 + Math.floor(((sy + 0.5) * gridHeight) / samplesY)
    for (let sx = 0; sx < samplesX; sx++) {
      const x = x0 + Math.floor(((sx + 0.5) * gridWidth) / samplesX)
      const c = classify(x, y)
      if (c < 0) continue
      points.push({ u: (x - x0) / gridWidth, v: (y - y0) / gridHeight, c })
    }
  }
  if (points.length < 200) return null

  // ===== 4. 套各种行列数，看哪种切分最像棋盘格 =====
  let best: { cols: number; rows: number; score: number } | null = null
  const MAX_COLS = 8
  const MAX_ROWS = 8

  for (let cols = 2; cols <= MAX_COLS; cols++) {
    for (let rows = 2; rows <= MAX_ROWS; rows++) {
      // parity → 各颜色的像素数
      const tally = [
        [0, 0],
        [0, 0],
      ]

      for (const point of points) {
        const ci = Math.min(cols - 1, Math.floor(point.u * cols))
        const ri = Math.min(rows - 1, Math.floor(point.v * rows))
        tally[(ci + ri) & 1][point.c]++
      }

      const sum0 = tally[0][0] + tally[0][1]
      const sum1 = tally[1][0] + tally[1][1]
      if (!sum0 || !sum1) continue

      // 每个奇偶格子里，主要颜色占多大比例
      const purity0 = Math.max(tally[0][0], tally[0][1]) / sum0
      const purity1 = Math.max(tally[1][0], tally[1][1]) / sum1
      // 两组奇偶格子必须「颜色不同」（斜对角同色 → 相邻不同色）
      const opposite = (tally[0][0] > tally[0][1]) !== (tally[1][0] > tally[1][1])
      if (!opposite) continue

      const score = Math.min(purity0, purity1)
      if (!best || score > best.score + 1e-6) {
        best = { cols, rows, score }
      }
    }
  }

  if (!best || best.score < 0.85) return null

  const labels: string[] = []
  for (let ci = 0; ci < best.cols; ci++) {
    for (let ri = 0; ri < best.rows; ri++) {
      labels.push(String.fromCharCode(65 + ci) + (ri + 1))
    }
  }

  const hex = (c: [number, number, number]) =>
    '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

  return {
    cols: best.cols,
    rows: best.rows,
    labels,
    colors: [hex(colorA), hex(colorB)],
    confidence: best.score,
  }
}

/** 从图片字节里直接认出区域代号；认不出来返回 null */
export function detectRegionLabels(buffer: Uint8Array): string[] | null {
  const image = decodePng(buffer)
  if (!image) return null
  const grid = detectGrid(image)
  return grid ? grid.labels : null
}

/** 颜色直方图（忽略半透明 / 近白 / 近黑），按像素数降序 */export function colorStats(image: DecodedImage, limit = 8) {
  const { width, height, data } = image
  const counts = new Map<number, number>()
  const boxes = new Map<number, [number, number, number, number]>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 200) continue
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (r > 245 && g > 245 && b > 245) continue // 近白
      if (r < 30 && g < 30 && b < 30) continue // 近黑（分子骨架线）
      const key = (r << 16) | (g << 8) | b
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const box = boxes.get(key)
      if (!box) boxes.set(key, [x, y, x, y])
      else {
        if (x < box[0]) box[0] = x
        if (y < box[1]) box[1] = y
        if (x > box[2]) box[2] = x
        if (y > box[3]) box[3] = y
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      hex: '#' + (((key >> 16) & 0xff) << 16 | (key & 0xff00) | ((key & 0xff) << 16)).toString(16).padStart(6, '0'),
      rgb: [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff] as [number, number, number],
      count,
      box: boxes.get(key)!,
    }))
}
