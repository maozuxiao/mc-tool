/** 1.0.75：翻译模型解耦 —— 避免把推理/Agent 模型用在确定性翻译任务上 */
import { describe, expect, it } from 'vitest'
import { pickTranslateModel } from '../../../renderer/src/translateModel'

const MODELS = [
  'hy3', 'hy4-preview', 'kimi-k3', 'glm-5.3-flash',
  'deepseek-v4.1-flash', 'hy3-preview-agent', 'auto'
]

describe('pickTranslateModel', () => {
  it('显式配置 translateModelId 优先级最高', () => {
    expect(pickTranslateModel('glm-5.3-flash', 'hy3-preview-agent', MODELS)).toBe('glm-5.3-flash')
    expect(pickTranslateModel('  glm-5.3-flash  ', 'hy3-preview-agent', MODELS))
      .toBe('glm-5.3-flash')
  })
  it('聊天模型不是推理型时原样复用', () => {
    expect(pickTranslateModel(undefined, 'glm-5.2', MODELS)).toBe('glm-5.2')
    expect(pickTranslateModel(undefined, 'hy3', MODELS)).toBe('hy3')
  })
  it('agent 模型自动换成服务商清单里的快模型', () => {
    // 清单里 hy3 在最前且非 agent，应优先选它而不是只有 flash 后缀的
    expect(pickTranslateModel(undefined, 'hy3-preview-agent', MODELS)).toBe('hy3')
    expect(pickTranslateModel(undefined, 'some-thinking-model', ['glm-5.3-flash']))
      .toBe('glm-5.3-flash')
  })
  it('候选里没有快模型时回退原模型，不会把 agent 候选误判成快模型', () => {
    expect(pickTranslateModel(undefined, 'hy3-preview-agent', ['hy3-preview-agent', 'kimi-k3']))
      .toBe('hy3-preview-agent') // 没有快模型时只能回退原模型
  })
  it('没有快模型 / 没有清单 / 没有聊天模型时都不抛异常', () => {
    expect(pickTranslateModel(undefined, 'hy3-preview-agent', [])).toBe('hy3-preview-agent')
    expect(pickTranslateModel(undefined, 'hy3-preview-agent', undefined)).toBe('hy3-preview-agent')
    expect(pickTranslateModel(undefined, undefined, MODELS)).toBeUndefined()
    expect(pickTranslateModel('', '', MODELS)).toBeUndefined()
  })
})
