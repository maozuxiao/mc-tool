// 与 OA 物料查询接口相关的常量，主进程 / 渲染进程共享
export const OA_ORIGIN = 'http://oa.streamax.com:8080'
export const OA_LOGIN_URL = 'http://oa.streamax.com:8080/'
export const BASE = 'http://oa.streamax.com:8080/ruiming/mc/materiel_ui/materielSearch.do'
export const ORG = '102'

// 生命状态 -> 样式类（用于 TAG 着色）
export const STATUS_CLS: Record<string, string> = {
  '量产': 'mq-green', '批量-推荐': 'mq-green',
  '研发样品': 'mq-blue', '未承样': 'mq-blue',
  '预退市': 'mq-amber', '逐步淘汰': 'mq-amber', '批量-不推荐': 'mq-amber',
  '退市': 'mq-red', '禁购': 'mq-red', '禁用': 'mq-red'
}

// 自动更新包所在的 GitHub raw 基础地址（打包产物 dist/* 提交进本仓库，raw 直链即更新源）
export const UPDATE_BASE_URL = 'https://github.com/maozuxiao/mc-tool/raw/main/dist'
