import { describe, it, expect } from 'vitest'
import { mcSkillSystemPrompt } from '../mcSkill'

/**
 * 表格保真输出规则：三种模式（ask / mc / build）的系统提示都必须带上同一套约束，
 * 避免模型为了让 markdown 表格「防误译」而改写设备号 / 车牌 / 表头 / 分隔符、
 * 或附带大段元信息与纯文本版追问。
 */
describe('mcSkillSystemPrompt · 表格保真输出', () => {
  const modes = ['ask', 'mc', 'build'] as const

  it('三种模式都包含表格保真规则的关键约束', () => {
    for (const mode of modes) {
      const prompt = mcSkillSystemPrompt(mode)
      expect(prompt, mode).toContain('保持原始数据与表头语义')
      expect(prompt, mode).toContain('不要用反引号（行内代码）包裹')
      expect(prompt, mode).toContain('不要改写表头文字')
      expect(prompt, mode).toContain('不要用顿号等自定义符号替代 Markdown 列分隔符')
      expect(prompt, mode).toContain('用 Markdown 转义')
      expect(prompt, mode).toContain('不要主动追问是否需要纯文本版')
    }
  })

  it('竖线转义在最终提示里是单个反斜杠加竖线（源码里写成 \\|）', () => {
    const prompt = mcSkillSystemPrompt('mc')
    expect(prompt).toContain('\\|')
  })

  it('仍保留原有的「表格使用 Markdown」与料号逐字输出规则', () => {
    for (const mode of modes) {
      const prompt = mcSkillSystemPrompt(mode)
      expect(prompt, mode).toContain('表格使用 Markdown')
    }
    // 料号逐字输出规则只在 mc / build 的 materialRules 里
    expect(mcSkillSystemPrompt('mc')).toContain('逐字一致')
    expect(mcSkillSystemPrompt('build')).toContain('逐字一致')
  })
})
