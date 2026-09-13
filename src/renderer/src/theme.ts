import type { BackgroundType } from 'animal-island-ui'

/**
 * 与库 `Card` 的 `pattern` 取值一一对应。
 *
 * 库源码里定义了 `CardPattern`（`components/Card/Card.d.ts`），但没有从包入口
 * `animal-island-ui` 再导出（入口只导出 `CardProps / CardType / CardColor`），
 * 因此这里按库的取值原样声明一份，避免走 `animal-island-ui/dist/...` 深路径导入。
 */
export type ThemePattern =
  | 'default'
  | 'app-pink'
  | 'purple'
  | 'app-blue'
  | 'app-yellow'
  | 'app-orange'
  | 'app-teal'
  | 'app-green'
  | 'app-red'
  | 'lime-green'
  | 'yellow-green'
  | 'brown'
  | 'warm-peach-pink'

/**
 * mc-tool 主题注册表（浅色多主题）。
 *
 * 一个主题 = 「壁纸图案」+「配套配色」。两者的取值直接对齐 animal-island-ui 的
 * `BackgroundType`（库内置的全部 18 种壁纸）与 `ThemePattern`
 * （库 `Card` 的 pattern-* 配色），因此主题里透出的壁纸、卡片描边、主操作按钮、标签
 * 天然同色系，不需要自造配色，也不会和库组件撞色。
 *
 * 设计取舍：
 * - 只做浅色系（不做深色/夜间模式）。
 * - `accent` 取配套 pattern 的**前景色**（如 pattern-app-green 的 #3a6b3a）而不是
 *   描边色：库的 pattern-* 前景色都是压过暗度的同色系深色，配白字可读，
 *   而描边色（如 #8ac68a）太亮，做按钮底会让白字糊掉。
 * - `accentSoft` 取 pattern 的**描边色**，只用于浅底纹、卡片描边、进度轨道等
 *   不需要承载文字的地方。
 * - 其余衍生态（卡片底、分隔线、深色 hover、浅色 tint）全部由 CSS 用
 *   `color-mix()` 从这两色算出来，见 styles.css 的「主题 token」段，
 *   这样每套主题只需维护 3 个颜色值。
 */

export interface ThemePreset {
  /** 壁纸图案，直接传给 `<Background type={...}>` */
  id: BackgroundType
  /** 配套配色，与库 `Card` 的 `pattern-*` 系列同色系 */
  pattern: ThemePattern
  /** 名称的 i18n key */
  labelKey: string
  /** 页面底色（与壁纸基底同色，作为壁纸层之下的兜底色） */
  page: string
  /** 强调色：主按钮 / 激活态 / 链接 / 焦点描边 */
  accent: string
  /** 强调浅调：浅底纹 / 卡片描边 / 进度轨道 */
  accentSoft: string
}

/** 18 套主题（覆盖库内置的全部背景类型），按「奶油系 → 草木系 → 糖果系」三档气质排序 */
export const THEMES: ThemePreset[] = [
  // ── 奶油系：中性暖调，纸感最强 ──
  {
    id: 'default',
    pattern: 'default',
    labelKey: 'themeDefault',
    page: '#f7f3df',
    accent: '#725d42',
    accentSoft: '#d4c4a8'
  },
  {
    id: 'grid',
    pattern: 'default',
    labelKey: 'themeGrid',
    page: '#f7f3df',
    accent: '#725d42',
    accentSoft: '#c4b89e'
  },
  {
    id: 'sprinkles',
    pattern: 'warm-peach-pink',
    labelKey: 'themeSprinkles',
    page: '#f5f0e0',
    accent: '#8a4a2a',
    accentSoft: '#e18c6f'
  },
  {
    // 场景图壁纸：甜甜圈角落（库内置整幅插画，非点阵图案）
    id: 'sweet-corner',
    pattern: 'app-pink',
    labelKey: 'themeSweetCorner',
    page: '#fdf3e3',
    accent: '#a85565',
    accentSoft: '#f8a6b2'
  },
  {
    // 场景图壁纸：咖啡时光
    id: 'coffee-break',
    pattern: 'brown',
    labelKey: 'themeCoffeeBreak',
    page: '#fdf3e3',
    accent: '#5a4a2a',
    accentSoft: '#9a835a'
  },
  {
    id: 'dots-brown',
    pattern: 'brown',
    labelKey: 'themeDotsBrown',
    page: '#f5f0e0',
    accent: '#5a4a2a',
    accentSoft: '#9a835a'
  },
  {
    id: 'dots-warm-peach-pink',
    pattern: 'warm-peach-pink',
    labelKey: 'themeDotsWarmPeachPink',
    page: '#fff0e8',
    accent: '#8a4a2a',
    accentSoft: '#e18c6f'
  },
  // ── 草木系：青绿调 ──
  {
    id: 'dots-dark-green',
    pattern: 'app-green',
    labelKey: 'themeDotsDarkGreen',
    page: '#bfe3bf',
    accent: '#3a6b3a',
    accentSoft: '#8ac68a'
  },
  {
    id: 'dots-green',
    pattern: 'app-green',
    labelKey: 'themeDotsGreen',
    page: '#e8f5e8',
    accent: '#3a6b3a',
    accentSoft: '#8ac68a'
  },
  {
    id: 'dots-teal',
    pattern: 'app-teal',
    labelKey: 'themeDotsTeal',
    page: '#e8faf5',
    accent: '#2a6b5a',
    accentSoft: '#82d5bb'
  },
  {
    id: 'dots-lime-green',
    pattern: 'lime-green',
    labelKey: 'themeDotsLimeGreen',
    page: '#f5f8e0',
    accent: '#5a6b28',
    accentSoft: '#d1da49'
  },
  {
    id: 'dots-yellow-green',
    pattern: 'yellow-green',
    labelKey: 'themeDotsYellowGreen',
    page: '#fffde8',
    accent: '#6a5a28',
    accentSoft: '#ecdf52'
  },
  // ── 糖果系：高饱和度点缀 ──
  {
    id: 'dots-pink',
    pattern: 'app-pink',
    labelKey: 'themeDotsPink',
    page: '#fde4e8',
    accent: '#a85565',
    accentSoft: '#f8a6b2'
  },
  {
    id: 'dots-purple',
    pattern: 'purple',
    labelKey: 'themeDotsPurple',
    page: '#f0e8ff',
    accent: '#6a3a9a',
    accentSoft: '#b77dee'
  },
  {
    id: 'dots-blue',
    pattern: 'app-blue',
    labelKey: 'themeDotsBlue',
    page: '#e8edff',
    accent: '#4a5a8a',
    accentSoft: '#889df0'
  },
  {
    id: 'dots-yellow',
    pattern: 'app-yellow',
    labelKey: 'themeDotsYellow',
    page: '#fff8e0',
    accent: '#7a6528',
    accentSoft: '#f7cd67'
  },
  {
    id: 'dots-orange',
    pattern: 'app-orange',
    labelKey: 'themeDotsOrange',
    page: '#fff0e8',
    accent: '#8a4a2a',
    accentSoft: '#e59266'
  },
  {
    id: 'dots-red',
    pattern: 'app-red',
    labelKey: 'themeDotsRed',
    page: '#ffe8e8',
    accent: '#9a3a3a',
    accentSoft: '#fc736d'
  }
]

export const DEFAULT_THEME: BackgroundType = 'default'

const STORAGE_KEY = 'mc-theme'

const byId = new Map<string, ThemePreset>(THEMES.map((t) => [t.id, t]))

export function getThemePreset(id: string): ThemePreset {
  return byId.get(id) ?? byId.get(DEFAULT_THEME)!
}

/**
 * 读取上次选择的主题。与 `mc-hidden-cols` 同构的容错写法：
 * 存储被禁用、值损坏或指向已下线的主题时一律回落到默认主题。
 */
export function readStoredTheme(): BackgroundType {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && byId.has(raw)) return raw as BackgroundType
  } catch {
    /* 存储不可用时忽略 */
  }
  return DEFAULT_THEME
}

export function persistTheme(id: BackgroundType): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
}

/**
 * 把主题落到 DOM：写 `data-theme` 属性 + 3 个原始色值。
 *
 * 其余衍生态（卡片底/分隔线/深色 hover/tint）留在 styles.css 用 `color-mix()`
 * 计算，避免把同一套推导逻辑按主题份数复制。
 *
 * 同时把库的 `--animal-*` 运行时 token 指向这些值（用 `var()` 间接引用，
 * 自定义属性里的 `var()` 会在使用处解析），于是 **库自带组件**
 * （Button / Tag / Select / Switch / Progress / Tabs…）也整体跟随主题，
 * 无需逐个传 className 覆盖 —— 这正是不再需要 `[class*="..."]` 命中库内部
 * 类名那种写法的原因。
 *
 * 该函数是同步的、只写样式属性，不触发任何 React 重渲染，可在
 * `createRoot().render()` 之前调用，从根上消除首屏闪色。
 */
export function applyTheme(id: BackgroundType): void {
  const preset = getThemePreset(id)
  const root = document.documentElement

  root.dataset.theme = preset.id

  // 主题原始值：派生 token 的输入
  root.style.setProperty('--mc-page', preset.page)
  root.style.setProperty('--mc-accent', preset.accent)
  root.style.setProperty('--mc-accent-soft', preset.accentSoft)

  // 同步给库 token，让库组件跟随主题
  root.style.setProperty('--animal-bg-color', 'var(--mc-page)')
  root.style.setProperty('--animal-bg-color-secondary', 'var(--mc-surface-2)')
  root.style.setProperty('--animal-primary-color', 'var(--mc-accent)')
  root.style.setProperty('--animal-primary-color-hover', 'var(--mc-accent-deep)')
  root.style.setProperty('--animal-primary-color-active', 'var(--mc-accent-deep)')
  root.style.setProperty('--animal-primary-color-bg', 'var(--mc-accent-tint)')
  root.style.setProperty('--animal-border-color', 'var(--mc-line)')
}
