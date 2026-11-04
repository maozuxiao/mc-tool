/**
 * Jira 技能提示词契约（白盒断言，防回归）
 *
 * 背景（两个方向都被用户反馈过，所以这里钉的是「中间那条线」）：
 *  1. 只给要点时，模型自作主张把中文改写成邮件体、附上英文译文、还补「您好 / Hello」寒暄；
 *  2. 改成「逐字照抄」后又走向另一个极端 —— 用户口述一句，贴进工单里生硬不通顺（2026-11-04）。
 *
 * 现在的口径：**成稿照抄；只给要点时默认润色成通顺书面语**，但不翻译、不扩写成邮件体、
 * 不补客套头尾、不增删事实。下面每一层（frontmatter / 硬规则 9 / 两处章节说明 / 工具 schema）
 * 都必须带着这条，否则以后谁删一句就退回其中一个极端。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const skill = readFileSync(join(root, 'resources/skills/jira-jsm/SKILL.md'), 'utf8')
const jiraSkill = readFileSync(join(root, 'src/main/ai/jiraSkill.ts'), 'utf8')

describe('Jira 技能：正文可润色，但不翻译 / 不扩写 / 不改事实', () => {
  it('frontmatter 的 description 就声明了（技能列表每轮可见，权重最高）', () => {
    const frontmatter = (skill.split('---')[1] || '').trim()
    expect(frontmatter).toContain('可轻度润色得更通顺专业')
    expect(frontmatter).toContain('不翻译、不扩写成邮件体')
  })

  it('硬规则第 9 条：成稿照抄、要点默认润色、翻译须用户明确要求', () => {
    expect(skill).toContain('正文可以润色，但不翻译、不扩写、不改事实')
    expect(skill).toContain('逐字照抄')
    expect(skill).toContain('默认帮他润色成通顺、专业、书面化')
    expect(skill).toContain('翻译只在用户明确要求时做')
    // 两条硬边界：不扩写成邮件体、不增删事实
    expect(skill).toContain('不扩写成邮件体')
    expect(skill).toContain('不改事实')
  })

  it('确认话术要求复述将要提交的完整正文（不是要点）', () => {
    expect(skill).toContain('将要提交的完整正文')
  })

  it('建单 / 加评论两章都引用了该硬规则', () => {
    expect(skill).toContain('原样照抄')
    expect(skill).toContain('帮他润色成通顺专业的书面语')
  })

  it('工具描述与参数描述同步约束（模型看工具 schema 时也能看到）', () => {
    // 参数描述：comment / description
    expect(jiraSkill).toContain('不要翻译、不要补寒暄')
    // 工具描述：jira_add_comment / jira_create_ticket
    expect(jiraSkill).toContain('不翻译、不附译文')
    expect(jiraSkill).toContain('帮他润色成通顺专业的书面语')
  })
})
