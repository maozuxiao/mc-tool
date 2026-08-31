import { runSkill, SKILL_FILE, skillExists } from './skillRuntime'

const SCRIPT = 'file_office.js'

/**
 * 下发给大模型的文件工具定义。
 * description 要写清「会被截断 / 越界会被拒绝」，否则模型不知道这些边界，
 * 会反复重试或直接把截断的内容当成完整内容。
 */
export const FILE_READ_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'file_read',
    description: '读取工作区内的文件。支持纯文本（md/txt/csv/json/log/yml/xml/html 等）、docx、xlsx、pptx、pdf；pdf 与中文文档会自动处理编码。单次最多返回约 200KB，返回中 truncated 为 true 表示被截断，需更多时用 offset/limit 分段读取。路径必须在工作区内，越界会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，建议使用相对工作区根目录的相对路径'
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
    description: '列出工作区某个目录的内容。不确定目录结构时先调用它定位文件。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要列出的目录，相对工作区根目录，默认当前目录'
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
    description: '在工作区内按文件名或内容搜索关键词，用于查找包含某内容的文件。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索词'
        },
        path: {
          type: 'string',
          description: '搜索起始目录，相对工作区根目录，默认工作区根'
        },
        nameOnly: {
          type: 'boolean',
          description: '仅按文件名搜索、不扫描内容，默认 false'
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
    description: '写入文本类文件（md/txt/csv/json/log/yml 等）。可分段追加。暂不支持生成 Office 二进制（docx/xlsx/pptx/pdf）。修改已有文件前必须先读取确认现有内容。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，相对工作区根目录'
        },
        content: {
          type: 'string',
          description: '要写入的文本，\\n 表示换行'
        },
        append: {
          type: 'boolean',
          description: '追加到末尾而非覆盖，默认 false'
        }
      },
      required: ['path', 'content']
    }
  }
}

/** Build 模式下发的全部文件工具 */
export const FILE_TOOL_DEFINITIONS = [
  FILE_READ_TOOL_DEFINITION,
  FILE_LIST_TOOL_DEFINITION,
  FILE_SEARCH_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION
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
  /** 工作区根目录，脚本侧据此做沙箱校验 */
  root: string
  /** 待读取路径，相对 root 或绝对（必须在 root 内） */
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
  const args = ['read', opts.path, '--root', opts.root, '--json']
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
 * 通用命令入口。后续接入 write / list / search / cmd 时，
 * 工具注册表统一走这里，主进程不必为每个命令再包一层。
 */
export async function runFileSkillCommand(
  command: string,
  args: string[],
  root: string | undefined,
  signal?: AbortSignal,
  timeoutMs = 120000
): Promise<any> {
  const full = [command, ...args, '--json']
  if (root) full.push('--root', root)
  const { json } = await runSkill({
    skillName: SKILL_FILE,
    script: SCRIPT,
    args: full,
    timeoutMs,
    signal
  })
  return json
}
