/**
 * 1.0.75：翻译用模型选择 —— 与 AI 聊天模型解耦。
 *
 * 事故背景：翻译按钮原来直接复用 `prefs.lastModelId`。用户把聊天模型切成
 * `hy3-preview-agent`（Agent / 推理型）后，即使只翻 1 条物料描述，模型也要先
 * 生成 1500~3200 字符思维链，日志实测 20~26 秒，按钮一直停在「翻译中 0/1」。
 *
 * 规则：显式配置 > 非推理聊天模型 > 从该服务商的模型清单里挑一个快模型 > 原样回退。
 * 纯函数，不依赖 React / Electron，便于单测。
 */

/** 明确的推理 / Agent 型模型（名字里能看出来的） */
const AGENT_MODEL_RE = /agent|thinking|reason|preview-agent/i
/** 各家常见的轻量 / 快速模型命名 */
const FAST_MODEL_RE = /flash|turbo|lite|mini|fast|^hy3$/i

export function pickTranslateModel(
  configured: string | undefined,
  chatModel: string | undefined,
  suggestions: string[] | undefined
): string | undefined {
  const explicit = String(configured || '').trim()
  if (explicit) return explicit
  if (!chatModel) return undefined
  if (!AGENT_MODEL_RE.test(chatModel)) return chatModel
  const fast = (suggestions || []).find(m =>
    FAST_MODEL_RE.test(m) && !AGENT_MODEL_RE.test(m))
  return fast || chatModel
}
