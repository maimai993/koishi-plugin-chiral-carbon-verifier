import { h } from 'koishi'

/**
 * QQ 内联按钮（markdown + keyboard）
 *
 * 只对**支持 INTERACTION_CREATE 的 QQ 适配器**（例如 koishi-plugin-adapter-qq-crack）有效：
 * 适配器会把消息里的 `button` 元素收集成 `keyboard`，跟 markdown 一起下发；
 * 用户点击后平台推送 `INTERACTION_CREATE`，适配器转成 `interaction/button` 会话，
 * `session.event.button.data` 里就是这里写的 `data` 字符串。
 *
 * ⚠️ 按官方文档（消息按钮 / 互动事件），`action.type` 是：
 *   0 = 跳转按钮（http / 小程序 scheme）
 *   1 = **回调按钮**：只把 data 回调给后台，触发 INTERACTION_CREATE
 *   2 = 指令按钮：自动在输入框插入 `@bot data`（会多出一条待发送指令）
 * 所以这里必须显式写 **type: 1**；不写的话 qq-crack 会按 2 处理，
 * 点下去就变成「发指令」而不是「回调」。
 */

/** 本插件按钮的 data 前缀，用来区分别的插件的按钮 */
export const BUTTON_PREFIX = 'ccv:'
/** 困难模式下提交已选好的区域 */
export const BUTTON_SUBMIT = 'ccv:submit'
/** 清空已选区域 */
export const BUTTON_CLEAR = 'ccv:clear'

/** 按钮样式：0 灰色线框，1 蓝色线框 */
export const BUTTON_STYLE_GREY = 0
export const BUTTON_STYLE_BLUE = 1

/** 区域按钮的 data 前缀：ccv:a:B2 */
const REGION_PREFIX = 'ccv:a:'

/** 回调按钮（action.type = 1） */
const ACTION_TYPE_CALLBACK = 1
/** 权限：所有人可点 */
const PERMISSION_EVERYONE = 2

/** 区域代号 → 按钮 data */
export function regionButtonData(code: string): string {
  return REGION_PREFIX + code.trim().toUpperCase()
}

/** 按钮 data → 区域代号（不是区域按钮则返回 null） */
export function parseRegionButtonData(data: string): string | null {
  if (!data.startsWith(REGION_PREFIX)) return null
  const code = data.slice(REGION_PREFIX.length).trim().toUpperCase()
  return code || null
}

/** 配置里的候选区域字符串 → 区域代号数组 */
export function parseButtonRegions(input: string | undefined): string[] {
  if (!input) return []
  const codes = input
    .split(/[,，、\s;；]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
  return Array.from(new Set(codes))
}

/**
 * 构造一个**回调按钮**。
 *
 * - 文字：`render_data.label` / `visited_label`（crack 也会用子元素文本兜底）
 * - 回调数据：`action.data`，点击后原样出现在 `session.event.button.data`
 * - `action.unsupport_tips` 是官方要求的**必填**项（客户端太老不支持按钮时弹的提示）
 */
export function callbackButton(options: {
  id: string
  data: string
  label: string
  visitedLabel?: string
  style?: number
}): h {
  const { id, data, label, visitedLabel = label, style = BUTTON_STYLE_BLUE } = options

  const element: any = h('button', {
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: ACTION_TYPE_CALLBACK,
      permission: { type: PERMISSION_EVERYONE },
      data,
      unsupport_tips: '当前QQ版本不支持按钮，请直接发送区域代号作答~',
      // enter / reply 只对「指令按钮」有意义，这里显式关掉：
      // qq-crack 会因为 type !== 0 自动塞一个 enter: true 进来，不覆盖的话就成了「点击自动发送」
      enter: false,
      reply: false,
    },
  }, label)

  // koishi 的 h() 会把顶层属性名驼峰化（render_data → renderData），
  // crack 适配器是按 snake_case 读的，这里补一份
  const attrs = element.attrs ?? {}
  if (attrs.renderData && !attrs.render_data) attrs.render_data = attrs.renderData

  return element as h
}

/** 区域代号按钮；已点选的变灰并打勾，让用户看得出自己选了哪些 */
export function regionButton(code: string, picked = false): h {
  const label = picked ? `✓ ${code}` : code
  return callbackButton({
    id: `ccv-a-${code}`,
    data: regionButtonData(code),
    label,
    style: picked ? BUTTON_STYLE_GREY : BUTTON_STYLE_BLUE,
  })
}

/** 「提交答案」按钮（困难模式用） */
export function submitButton(label = '✅ 提交答案'): h {
  return callbackButton({
    id: 'ccv-submit',
    data: BUTTON_SUBMIT,
    label,
    style: BUTTON_STYLE_BLUE,
  })
}

/** 「清空」按钮（困难模式用） */
export function clearButton(label = '🧹 清空'): h {
  return callbackButton({
    id: 'ccv-clear',
    data: BUTTON_CLEAR,
    label,
    style: BUTTON_STYLE_GREY,
  })
}
