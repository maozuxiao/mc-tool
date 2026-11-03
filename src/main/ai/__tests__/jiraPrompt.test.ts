/**
 * Jira 技能提示词契约（白盒断言，防回归）
 *
 * 背景：用户只给了评论要点，模型却自作主张把中文改写成邮件体并**附了一段英文译文**，
 * 还加上了「您好 / Hello」寒暄。原因不是代码 bug，而是提示词里缺少「正文照抄」的约束。
 * 这里把约束钉住：SKILL.md（含 frontmatter，每轮都进 system prompt）与工具描述必须都带着它，
 * 否则以后谁删一句就又退回去自己改写。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const skill = readFileSync(join(root, 'resources/skills/jira-jsm/SKILL.md'), 'utf8')
const jiraSkill = readFileSync(join(root, 'src/main/ai/jiraSkill.ts'), 'utf8')

describe('Jira 技能：评论正文 / 工单描述不改写不翻译', () => {
  it('frontmatter 的 description 就声明了（技能列表每轮可见，权重最高）', () => {
    const frontmatter = (skill.split('---')[1] || '').trim()
    expect(frontmatter).toContain('不翻译、不改写、不补寒暄')
  })

  it('硬规则第 9 条：成稿逐字照抄、只连要点、翻译须用户明确要求', () => {
    expect(skill).toContain('不改写、不翻译、不补寒暄')
    expect(skill).toContain('逐字照抄')
    expect(skill).toContain('只能连接已有事实')
    expect(skill).toContain('翻译只在用户明确要求时做')
  })

  it('确认话术要求复述逐字文本', () => {
    expect(skill).toContain('将要提交的逐字文本')
  })

  it('建单 / 加评论两章都引用了该硬规则', () => {
    expect(skill).toContain('正文原样提交')
    expect(skill).toContain('不要替他润色或翻译')
  })

  it('工具描述与参数描述同步约束（模型看工具 schema 时也能看到）', () => {
    // 参数描述：comment / description
    expect(jiraSkill).toContain('不要翻译、不要润色、不要补寒暄')
    // 工具描述：jira_add_comment / jira_create_ticket
    expect(jiraSkill).toContain('不改写、不润色、不翻译、不补「您好 / Hello」寒暄')
  })
})
