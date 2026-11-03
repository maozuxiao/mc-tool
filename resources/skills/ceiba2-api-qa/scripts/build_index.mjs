#!/usr/bin/env node
/**
 * 从 api_full.md 生成 api_reference.md（Ceiba2 / WCMS5 接口索引）。
 *
 * 用法：
 *   node scripts/build_index.mjs 2.6.3
 *   node scripts/build_index.mjs 2.6.8
 *   node scripts/build_index.mjs --all
 *
 * 为什么要有这个脚本：索引是 44 / 64 条接口的机械摘录，手抄必然漏行、行号必然漂移。
 * 脚本保证「索引里的每一条都能按行号回到原文」，也让后续新版本文档只要替换 api_full.md
 * 再跑一次即可。
 *
 * 行号基准：原文 `api_full.md` 顶部可能被加了「来源」抬头，条目里的 `L1234` 一律按
 * **原始文档行号**（去掉抬头后的行号）给出，与原索引口径保持一致。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REFERENCES = join(SKILL_ROOT, 'references')

// ── 各版本的抬头（来源 / 日期不同，正文约定两版一致）────────────────────
const GLOBAL_CONVENTIONS = `## 全局约定（所有接口通用）

- 地址：\`http://{HOST}:{PORT}/api/v1/basic/...\`（\`{HOST}:{PORT}\` 是 CMS 服务器地址，例 \`192.168.1.10:12056\`）。
- 编码：UTF-8；交互格式 JSON；除特别说明外都支持 jsonp，回调名统一为 \`callback\`。
- \`GET\`：参数放 query，中文/特殊字符需 URL encode。
- \`POST\`：\`Content-Type: application/json\`，参数放 **JSON body**（body 里也要带 \`key\`）。
- 鉴权：先调 \`1.1 验证接口\` 拿 \`key\`，之后**每个请求**都要带 \`key\`。
- 时间格式：绝大多数接口为 \`YYYY-MM-DD HH:mm:ss\`；**6.1 里程** 用 \`YYYY-MM-DD\`（且参数名首字母大写 \`Starttime\`/\`Endtime\`）。
- 终端号：\`terid\`；有的接口收**数组**，有的收**单个字符串**（见各接口）。
- 通道号：\`chl\` 在 8.x 是**逗号分隔字符串**（\`chl=1,2,3,4\`），在 9.1 是**整型数组**（\`[1,2,3,4]\`）。
- 服务器上的文件路径参数（\`dir\`）是 **base64 编码**（9.4 / 16.1 / 16.2）。

## 接口清单`

const COMMON_TAIL = `> 本文件按接口逐条列出：**路径 / 请求方式 / 请求参数 / 返回字段 / 原文注意事项**。
> 用来「客户说某个接口报错」时快速核对参数名、类型、格式；完整示例与字段解释见 \`api_full.md\`。
> 每个条目标注了在原文里的行号（\`L1234\`），需要看原始 JSON 示例时按行号去 \`api_full.md\` 查。`

const VERSIONS = {
  '2.6.3': {
    header: `# Ceiba2 / WCMS5 API 接口索引（自动生成）

> 来源：Ceiba2 / WCMS5 服务端自带 API 文档（\`CMS Server\\WCMS5\\root\\public\\help\\api\`，版本 **2.6.3**），由用户于 2026-09-30 导入本技能。原文为英文，此文件保持原样未翻译（便于对照客户/研发用的术语）。

${COMMON_TAIL}

${GLOBAL_CONVENTIONS}`,
    notes: {}
  },
  '2.6.8': {
    header: `# Ceiba2 / WCMS5 API 接口索引（自动生成 · v2.6.8）

> 来源：Ceiba2 / WCMS5 服务端 API 文档（\`help/api\`，版本 **2.6.8**），由用户于 2026-11-03 导入本技能。原文为英文，此文件保持原样未翻译（便于对照客户/研发用的术语）。

> **版本警示（必读）**：本文件只描述 **v2.6.8**，章节号仅在本版本内有效。2.6.3 的 \`12.1/12.2\` 是 User Log（本版已整章删除），因此 12~15 章整体换了内容：本版 \`12.x\`=客流、\`13.x\`=人脸、\`14.x\`=证据中心、\`15.x\`=刷卡。**不要**把 2.6.3 的章节号套到本版，也不要拿本版的 14.x 去回答 2.6.3 客户的问题（那是人脸比对）。两版增删对照见 \`../version_diff.md\`。

${COMMON_TAIL}

${GLOBAL_CONVENTIONS}`,
    // 同号不同义：必须显式提醒，否则模型会把两版同号接口混为一谈
    notes: {
      '12.1': '2.6.3 的 12.1 是 Add user operation log（User Log 章节在 2.6.8 中已整章删除），本版 12.1 改为客流明细。',
      '13.1': '2.6.3 的 13.1 是 Query passenger flow detail（客流），本版 13.1 改为人脸比对记录数。',
      '13.2': '2.6.3 没有人脸比对的第二个接口（该版 14.x 才是人脸），本版 13.2 是人脸比对记录明细。',
      '14.1': '2.6.3 的 14.x 是人脸比对（14.1 记录数 / 14.2 明细），本版 14.x 才是证据中心。',
      '15.1': '2.6.3 的 15.x 是证据中心（15.1~15.8），本版 15.x 改为刷卡数据。',
      '11.1': '本版由 Terminal interface 更名为 Remote control interface，路径与参数不变。'
    }
  }
}

// ── 解析 ────────────────────────────────────────────────────────────────
const HEADING = /^###\s+(\d+(?:\.\d+)*)\s+(.+?)\s*$/

/** 去掉代码围栏，取出 `**address:**` 后面的第一段地址文本 */
function pickAddress(region) {
  const i = region.findIndex(l => /^\*\*address:?\*\*/.test(l))
  if (i < 0) return ''
  for (let j = i + 1; j < region.length; j++) {
    const line = region[j].trim()
    if (line.startsWith('```')) {
      const buf = []
      for (let k = j + 1; k < region.length && !region[k].trim().startsWith('```'); k++) buf.push(region[k].trim())
      return buf.filter(Boolean).join(' ')
    }
    if (line && !line.startsWith('```')) return line
  }
  return ''
}

/** `**request:** \`POST\`` → POST */
function pickMethod(region) {
  for (const line of region) {
    const m = /^\*\*request:?\*\*\s*`?([A-Za-z]+)`?/.exec(line)
    if (m) return m[1].toUpperCase()
  }
  return ''
}

/**
 * 取某个 `**label:**` 小节下的 `- xxx` 列表（直到下一个 `**` 小节或二级标题）。
 * 返回原始行文本（已去掉 `- ` 前缀），保留原文空格 —— 索引与原文要能逐字对照。
 */
function pickBullets(region, labelRe) {
  const i = region.findIndex(l => labelRe.test(l))
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < region.length; j++) {
    const raw = region[j]
    const line = raw.trim()
    if (!line) continue
    if (/^\*\*/.test(line) || /^#{2,3}\s/.test(line)) break
    if (line.startsWith('```')) break
    if (/^[-*]\s+/.test(line)) out.push(line.replace(/^[-*]\s+/, ''))
  }
  return out
}

function parse(fullText) {
  const lines = fullText.split(/\r?\n/)
  // 行号基准：第一个一级标题之前的行（来源抬头）不计入
  const firstH1 = lines.findIndex(l => /^#\s/.test(l))
  const offset = firstH1 > 0 ? firstH1 : 0

  const items = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i])
    if (!m) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{2,3}\s/.test(lines[j])) { end = j; break }
    }
    const region = lines.slice(i, end)
    items.push({
      num: m[1],
      title: m[2],
      line: i + 1 - offset,
      path: pickAddress(region),
      method: pickMethod(region),
      params: pickBullets(region, /^\*\*parameter description:?\*\*/),
      returns: pickBullets(region, /^\*\*response description:?\*\*/)
    })
  }
  return items
}

function render(version, items) {
  const meta = VERSIONS[version]
  if (!meta) throw new Error(`未登记的版本：${version}（可选：${Object.keys(VERSIONS).join(' / ')}）`)
  const blocks = items.map(it => {
    const note = meta.notes[it.num]
    const lines = [`### ${it.num} ${it.title}`]
    if (note) lines.push(`> **版本差异**：${note}`)
    // 标题与第一条之间留空行：与原人工索引的排版保持一致（便于逐字回归比对）
    if (lines.length) lines.push('')
    lines.push(`- **路径**：\`${it.path || '（原文未给地址，见 api_full）'}\``)
    lines.push(`- **方式**：\`${it.method || '—'}\``)
    lines.push(`- **请求参数**：${it.params.length ? it.params.join('；') : '无（原文未列）'}`)
    lines.push(`- **返回字段**：${it.returns.length ? it.returns.join('；') : '无（原文未列）'}`)
    lines.push(`- **原文位置**：\`api_full.md\` L${it.line}`)
    return lines.join('\n')
  })
  return `${meta.header}\n\n${blocks.join('\n\n')}\n`
}

function build(version) {
  const src = join(REFERENCES, version, 'api_full.md')
  if (!existsSync(src)) throw new Error(`缺少原文：${src}`)
  const items = parse(readFileSync(src, 'utf8'))
  if (!items.length) throw new Error('没有解析出任何接口条目，检查 api_full.md 是否为 Markdown 版')
  const out = join(REFERENCES, version, 'api_reference.md')
  writeFileSync(out, render(version, items), 'utf8')
  const missing = items.filter(it => !it.path || it.path.includes('未给地址'))
  console.log(`[${version}] 接口 ${items.length} 条 → ${out}`)
  if (missing.length) console.warn(`  警告：${missing.length} 条未解析出地址：${missing.map(m => m.num).join(', ')}`)
}

const arg = process.argv[2]
if (!arg) {
  console.error('用法：node scripts/build_index.mjs 2.6.8 | --all')
  process.exit(1)
}
for (const v of arg === '--all' ? Object.keys(VERSIONS) : [arg]) build(v)
