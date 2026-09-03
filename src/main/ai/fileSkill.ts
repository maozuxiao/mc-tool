import { runSkill, SKILL_FILE, skillExists } from './skillRuntime'
import { downloadToDir } from './fileDownload'
import type { AIExtraRoot } from '@shared/ai-types'

const SCRIPT = 'file_office.js'

// 把多根白名单拼成脚本参数：主根用 --root，额外根用 --extra-root <别名>|<目录>
function rootArgs(roots: AIExtraRoot[]): string[] {
  const args: string[] = []
  for (const r of roots) {
    if (r.alias === '') args.push('--root', r.path)
    else args.push('--extra-root', `${r.alias}|${r.path}`)
  }
  return args
}

/**
 * 下发给大模型的文件工具定义。
 * description 要写清「会被截断 / 越界会被拒绝 / 别名前缀」，否则模型不知道这些边界，
 * 会反复重试或直接把截断的内容当成完整内容。
 */
export const FILE_READ_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_read',
    description: '读取文件。支持纯文本（md/txt/csv/json/log/yml/xml/html 等）、docx、xls、xlsx、pptx、pdf；pdf 与中文文档已自动处理编码。单次最多返回约 200KB，返回里 truncated 为 true 表示被截断，需更多时用 offset/limit 分段读取。路径直接用本机绝对路径（如 C:/Users/张三/文档/报告.xlsx、D:/共享/出货记录.xls），也可用 open_folder 打开目录后返回的「别名/路径」前缀；不传别名时按绝对/相对路径直接访问本机文件。若返回 EBUSY/文件被占用，说明该文件正被其他程序（如 Excel）打开，提示用户关闭后再重试即可。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径。若用户已给出完整绝对路径（含盘符，如 E:/销售相关/PI/Murat/某文件.xlsx），必须原样完整传入，禁止截断成别名；否则可用 open_folder 返回的「别名/路径」'
        },
        offset: {
          type: 'number',
          description: '起始行号（0 基），用于分段读取大文件，默认 0'
        },
        limit: {
          type: 'number',
          description: '本次读取的行数，0 表示不限（仍受 200KB 上限约束）'
        }
      },
      required: ['path']
    }
  }
}

export const FILE_LIST_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_list',
    description: '列出某目录的内容。不确定目录结构时先调用它定位文件。路径用法同 file_read（绝对路径或「别名/路径」）。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要列出的目录。若用户已给出完整绝对路径（含盘符），必须原样完整传入；否则可用 open_folder 返回的「别名/路径」；省略时默认当前目录'
        },
        depth: {
          type: 'number',
          description: '递归深度，默认 1（仅当前目录）'
        }
      },
      required: []
    }
  }
}

export const FILE_SEARCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_search',
    description: '搜索文件（类 FileLocatorPro 的内容检索）。query 默认同时匹配文件名与内容；' +
      '含 * 或 ? 时按文件名通配符匹配；--regex 时按正则表达式匹配。' +
      '内容搜索覆盖多种格式：文本类、xlsx/xls（命中定位到 sheet+行号）、docx/pptx/pdf（返回命中片段）。' +
      '用 glob 限定只搜某类文件（如 *.xls），用 ext 限定扩展名（如 xls,xlsx）。默认不使用缓存索引，每次直接读取文件，避免大表缓存漏行；' +
      '只有对未改动的同一组大文件需要多次搜索加速时，才设 index=true 启用缓存（缓存会校验文件 hash，但关键查料号场景仍建议保持 false）。路径用法同 file_read（绝对路径或「别名/路径」）。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索词/通配符/正则。含 * ? 视为文件名通配；配合 regex=true 视为正则'
        },
        path: {
          type: 'string',
          description: '搜索起始目录。若用户已给出完整绝对路径（含盘符），必须原样完整传入；否则可用 open_folder 返回的「别名/路径」；省略时默认当前目录'
        },
        nameOnly: {
          type: 'boolean',
          description: '仅按文件名匹配、不扫描内容，默认 false'
        },
        regex: {
          type: 'boolean',
          description: '将 query 当作正则表达式（文件名与内容均按正则匹配），默认 false'
        },
        glob: {
          type: 'string',
          description: '只扫描文件名匹配该通配符的文件，如 "*.xls"，用于限定文件类型'
        },
        ext: {
          type: 'string',
          description: '只扫描指定扩展名，逗号分隔，如 "xls,xlsx"'
        },
        index: {
          type: 'boolean',
          description: '是否使用缓存索引加速（默认 false）；为保证准确性（尤其 xlsx/xls 大表查料号），建议保持 false；只有对未改动的大目录多次搜索时才设为 true'
        }
      },
      required: ['query']
    }
  }
}

export const FILE_WRITE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_write',
    description: '写入文件。文本类（md/txt/csv/json/log/yml 等）直接给文本内容；电子表格（xlsx / xls）把内容以 CSV/TSV（首行表头）或 JSON（二维数组 / 对象数组）形式给出，工具会生成真正的二进制工作簿（支持 --append 分段追加）。回填/修复已有电子表格时设 update=true，content 给 JSON：{ "key": "关键列名", "rows": [ { "关键列": "值", "要填的列": "值", ... } ] }，工具按关键列匹配原表行、把其余列写回（原表没有的列自动追加到最右），原地保存不另存新文件。要在已存在的工作簿里新增一个 Sheet（与 Sheet1 等原表并存、保留原表样式）则传 newsheet：可传具体名称（如 "汇总"）或 true 表示自动命名 Sheet2/Sheet3…；newsheet 与 update 互斥，且目标文件必须已存在。用户要求「新建子表/新工作表/Sheet2」时必须用 newsheet，不要用 update 在原表上追加列。【重要】已存在的表格做任何改动（新增行/列、写回数据、标记颜色、新建子表）都必须用 update=true 或 newsheet 在原工作簿上原地处理，禁止用无 update/newsheet 的 write 重建文件（会丢失原工作表名与样式）。单元格背景色：任意单元格值可写成 { "value": "文本", "fill": "green" }；整行上色加 "__rowFill": "yellow"（用户说「当前行」/「这一行」标色时必须用整行填充，会填满从 A 列到最右列，不要只给单个单元格上色；多路径判断时按「任一命中即绿，全部未命中才黄」统一整行颜色：例如「Murat记录」和「Order summary记录」两列，只要任一列不是「无」/「无记录」（如有具体记录），该行 __rowFill 就必须为 green；只有当两列都是「无」/「无记录」时才为 yellow；禁止把一行拆成 A-D 绿、E-J 黄几段分别上色）。fill 支持 green/yellow/red/blue/gray/orange（及 light 前缀变体）或 #RRGGBB。修改已有文件前必须先读取确认现有内容，不要凭空覆盖。写入前若目标列在原表已有内容（非空白），应先向用户确认是否覆盖，待用户明确确认后再写入；用户明确指定写入某列时，必须严格写到该列，禁止因为原表存在同名的其他列就改写到别处。路径用法同 file_read（可直接绝对路径或「别名/路径」）。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径。若用户已给出完整绝对路径（含盘符），必须原样完整传入；否则可用 open_folder 返回的「别名/路径」'
        },
        content: {
          type: 'string',
          description: '要写入的文本，\\n 表示换行；update=true 时改为 JSON：{ key, rows }'
        },
        append: {
          type: 'boolean',
          description: '追加到末尾而非覆盖，默认 false'
        },
        update: {
          type: 'boolean',
          description: '仅对 xlsx/xls 生效：true 时按 content 的 key 列原地回填/追加列，而非生成新工作簿'
        },
        newsheet: {
          type: 'string',
          description: '仅对 xlsx/xls 生效：在已存在的工作簿中追加一个新工作表（与 Sheet1 等原表并存、保留原表样式）。传具体字符串作为新表名称（如 "汇总"）；传 "true" 表示自动命名为 Sheet2/Sheet3…。与 update 互斥，目标文件必须已存在。'
        }
      },
      required: ['path', 'content']
    }
  }
}

// 批量读取：一次工具调用读取多个文件，只消耗 1 轮，避免「一个文件一轮」耗尽轮次上限
export const FILE_READ_BATCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_read_batch',
    description: '一次读取多个文件（最多 12 个），只消耗一次工具调用。每个文件返回 { ok, relative, format, text, truncated }。' +
      '已知多个目标文件时优先用它，禁止逐个调用 file_read。路径用法同 file_read（绝对路径或「别名/路径」）。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要读取的文件路径数组。若用户已给出完整绝对路径（含盘符），必须原样完整传入；否则可用 open_folder 返回的「别名/路径」'
        }
      },
      required: ['paths']
    }
  }
}

// 会话级「打开目录」：当用户提到的目录/文件路径不在已授权目录内时调用。
// 主进程会校验并（首次）请求用户确认，返回该目录的别名供后续「别名/路径」引用。
export const FILE_OPEN_FOLDER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'open_folder',
    description: '打开一个目录供 AI 在本会话内访问（只读/写该目录及其子目录）。' +
      '当用户在聊天里提到某个目录或文件路径、而它不在已授权目录内时调用。' +
      'path 传绝对路径（目录或文件均可；传文件会自动取其父目录）。' +
      '返回该目录的别名，之后用「别名/路径」引用其中的文件。首次打开新目录会请求用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要打开的目录或文件的绝对路径'
        }
      },
      required: ['path']
    }
  }
}

// 下载文件到指定目录：下载在主进程完成（Cookie 不出主进程），
// 目录受已授权工作区白名单约束，目录不存在自动创建、同名文件自动重命名。
export const FILE_DOWNLOAD_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_download',
    description: '把 URL 下载到指定目录。url 为必填（OA 规格文件链接或任意 http(s) 链接），dir 为必填目标目录（绝对路径或「别名/路径」，必须在已授权工作区内）。' +
      'OA 域文件会自动复用当前 OA 登录态，未登录时返回 NEED_RELOGIN（此时提示用户先在应用内登录 OA）。' +
      'dir 不存在会自动创建；同名文件自动重命名为「名称(1).ext」「名称(2).ext」，不会覆盖已有文件。' +
      '可选 name 指定保存的文件名，省略则由链接推断（OA 规格文件取 fileName= 参数）。' +
      '单次下载上限 200MB、超时 60 秒。若返回 PATH_OUTSIDE_ROOT 说明目录不在已授权工作区内，应引导用户用 open_folder 打开该目录后再下载。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要下载的文件 URL。OA 规格文件链接（oa.streamax.com 的 specificationFileDownload）或任意 http/https 直链'
        },
        dir: {
          type: 'string',
          description: '保存到的目录。若用户已给出完整绝对路径（含盘符，如 D:/资料/规格文件），必须原样完整传入；否则可用 open_folder 返回的「别名/路径」；必须在已授权工作区内'
        },
        name: {
          type: 'string',
          description: '可选。保存时使用的文件名（可含扩展名）；省略则由 URL 推断'
        }
      },
      required: ['url', 'dir']
    }
  }
}

/** Build 模式下发的全部文件工具（含批量读取、打开目录、下载） */
export const FILE_TOOL_DEFINITIONS = [
  FILE_READ_TOOL_DEFINITION,
  FILE_LIST_TOOL_DEFINITION,
  FILE_SEARCH_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  FILE_READ_BATCH_TOOL_DEFINITION,
  FILE_OPEN_FOLDER_TOOL_DEFINITION,
  FILE_DOWNLOAD_TOOL_DEFINITION
]

export function fileSkillAvailable(): boolean {
  return skillExists(SKILL_FILE, SCRIPT)
}

/**
 * 健康检查：把「依赖缺失 / 原生模块加载失败」在第一次调用时就暴露出来，
 * 而不是等用户真的要读某个格式时才炸。
 */
export async function fileSkillPing(signal?: AbortSignal): Promise<any> {
  const { json } = await runSkill({
    skillName: SKILL_FILE,
    script: SCRIPT,
    args: ['ping', '--json'],
    // 首次调用可能触发 Node 自举下载，给足时间
    timeoutMs: 180000,
    signal
  })
  return json
}

export interface FileReadOptions {
  /** 已授权目录白名单（多根） */
  roots: AIExtraRoot[]
  /** 待读取路径，相对某根或绝对（必须在某根内） */
  path: string
  /** 起始行（0 基），用于分段读大文件 */
  offset?: number
  /** 读取行数，0 表示不限 */
  limit?: number
  /** 字节上限，脚本内还会再夹一次硬上限 */
  maxBytes?: number
  signal?: AbortSignal
}

export async function fileSkillRead(opts: FileReadOptions): Promise<any> {
  const args = ['read', opts.path, '--json', ...rootArgs(opts.roots)]
  if (typeof opts.offset === 'number' && opts.offset > 0) args.push('--offset', String(opts.offset))
  if (typeof opts.limit === 'number' && opts.limit > 0) args.push('--limit', String(opts.limit))
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0) args.push('--max-bytes', String(opts.maxBytes))

  const { json } = await runSkill({
    skillName: SKILL_FILE,
    script: SCRIPT,
    args,
    timeoutMs: 60000,
    signal: opts.signal
  })
  return json
}

/**
 * 下载 URL 到指定目录。
 * 由主进程的 downloadToDir 完成：目录归属校验（必须在已授权工作区内）、
 * 目录不存在自动创建、同名自动重命名、OA 文件自动带登录态。
 * 下载不经过子进程脚本，Cookie 始终留在主进程内。
 */
export async function fileSkillDownload(opts: {
  url: string
  dir: string
  name?: string
  roots: AIExtraRoot[]
}): Promise<any> {
  const url = String(opts?.url || '').trim()
  const dir = String(opts?.dir || '').trim()
  if (!url) return { ok: false, error: 'MISSING_ARG', message: '缺少 url 参数' }
  if (!dir) return { ok: false, error: 'MISSING_ARG', message: '缺少 dir 参数' }
  return downloadToDir({ url, dir, name: opts?.name, roots: opts.roots })
}

/**
 * 通用命令入口。后续接入 write / list / search / cmd 时，
 * 工具注册表统一走这里，主进程不必为每个命令再包一层。
 */
export async function runFileSkillCommand(
  command: string,
  args: string[],
  roots: AIExtraRoot[],
  signal?: AbortSignal,
  timeoutMs = 120000
): Promise<any> {
  const full = [command, ...args, '--json', ...rootArgs(roots)]
  const { json } = await runSkill({
    skillName: SKILL_FILE,
    script: SCRIPT,
    args: full,
    timeoutMs,
    signal
  })
  return json
}
