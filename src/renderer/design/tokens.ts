/**
 * 设计 tokens 的单一来源（方向：英语学习词典，见 docs/设计方向-学习词典.md 第三节）。
 *
 * 三处同步，全部从这里生成，不要在别处手写颜色：
 *   1. CSS 变量   → cssVariablesText()   由 ThemeProvider 注入 <style id="ewb-tokens">，变量统一前缀 --ewb-
 *   2. AntD 主题  → antdTheme(mode)      ConfigProvider 的 theme（algorithm + token + 组件 token）
 *   3. ECharts    → echartsTheme(mode)   registerEChartsThemes(echarts) 注册为 ewb-light / ewb-dark
 *
 * 浅色 = 词典内页（冷白纸），深色 = 夜读版（深蓝封面布底）。
 */
import { theme as antdThemeApi, type ThemeConfig } from 'antd'

export type Mode = 'light' | 'dark'

// ───────────────────────────── 基础色 ─────────────────────────────

export interface Palette {
  /** 应用底色（浅灰 / 深紫靛），白色大画布浮在它上面 */
  paper: string
  /** 画布内的第二层中性色：表头、折叠面板头、说明格底 */
  paper2: string
  /** 画布 / 卡片底色（浅色白，深色 #1D1D35） */
  page: string
  /** 浮层底色：下拉、对话框、抽屉（浅色同内页，深色略提亮以便和遮罩分开） */
  elevated: string
  /** 正文墨 */
  ink: string
  /** 次要文字：说明、标签（对比度 ≥ 4.5:1） */
  ink2: string
  /** 占位文字（对比度 ≥ 4.5:1） */
  placeholder: string
  /** 主色（长春花紫）：词头、当前导航、主按钮、链接 */
  primary: string
  primaryHover: string
  primaryActive: string
  /** 主色的浅底：选中行、悬停行 */
  primarySoft: string
  /** 主按钮上的文字（浅色白，深色取应用底色） */
  onPrimary: string
  /** 易错（玫红）：只给易错、失败、需要处理的事项 */
  red: string
  /** 易错红的文字版：放在红色浅底上也 ≥ 4.5:1（浅色模式的玫红在浅底上不到 4.5） */
  redInk: string
  redSoft: string
  /** 红色细线（易错用法框的 1px 边框） */
  redLine: string
  /** 红色实心标签上的文字 */
  onRed: string
  /** 信息框：「辨析」「提示」框的底色 */
  note: string
  /** 细线：1px 分隔线 */
  line: string
  /** 比细线重一档的线：输入框、次按钮描边 */
  lineStrong: string
  /** 成功 / 警告的反馈色。仅供未迁移页面里的 AntD 默认控件兜底，新界面不用（状态靠文字标签） */
  ok: string
  warn: string
  /** 遮罩 */
  mask: string
  /** 浮层阴影（只给下拉、抽屉、对话框） */
  shadowPop: string
  /** 原卷纸：深色模式下原卷、页面图仍是白纸 */
  sheet: string
  sheetInk: string
}

export const palettes: Record<Mode, Palette> = {
  light: {
    // 第二版（参考 Dribbble「LMS Dashboard」）：浅灰应用底 + 白色大画布；长春花紫主色；玫红易错
    paper: '#ECECF1',
    paper2: '#F6F6FB',
    page: '#FFFFFF',
    elevated: '#FFFFFF',
    ink: '#1C1B2E',
    ink2: '#5E5D75',
    placeholder: '#6B6A82',
    primary: '#5B57D1',
    primaryHover: '#4B47BC',
    primaryActive: '#3E3AA3',
    primarySoft: '#EEEDFB',
    onPrimary: '#FFFFFF',
    red: '#D63B53',
    redInk: '#B52A40',
    redSoft: 'rgba(214, 59, 83, 0.08)',
    redLine: 'rgba(214, 59, 83, 0.5)',
    onRed: '#FFFFFF',
    note: '#F2F2F9',
    line: '#D9D8E6',
    lineStrong: '#8D8CA6',
    ok: '#1F7A4D',
    warn: '#9A5B00',
    mask: 'rgba(28, 27, 46, 0.5)',
    shadowPop: '0 10px 28px rgba(28, 27, 46, 0.14)',
    sheet: '#FFFFFF',
    sheetInk: '#1C1B2E'
  },
  dark: {
    // 夜读版：深紫靛底 + 稍亮的画布
    paper: '#141427',
    paper2: '#23233F',
    page: '#1D1D35',
    elevated: '#26264A',
    ink: '#ECEBF7',
    ink2: '#A9A8C2',
    placeholder: '#9A99B4',
    primary: '#9C98FF',
    primaryHover: '#B3B0FF',
    primaryActive: '#CBC9FF',
    primarySoft: '#2B2B55',
    onPrimary: '#141427',
    red: '#FF7A8C',
    redInk: '#FF7A8C',
    redSoft: 'rgba(255, 122, 140, 0.14)',
    redLine: 'rgba(255, 122, 140, 0.55)',
    onRed: '#141427',
    note: '#25254A',
    line: 'rgba(236, 235, 247, 0.16)',
    lineStrong: 'rgba(236, 235, 247, 0.42)',
    ok: '#5FD39B',
    warn: '#F2B84B',
    mask: 'rgba(8, 8, 20, 0.66)',
    shadowPop: '0 10px 28px rgba(0, 0, 0, 0.45)',
    sheet: '#FFFFFF',
    sheetInk: '#1C1B2E'
  }
}

// ───────────────────────────── 六色拇指索引 ─────────────────────────────

export type CategoryKey = 'phonics' | 'vocab' | 'grammar' | 'communication' | 'reading' | 'writing'

export interface Category {
  key: CategoryKey
  /** 中文名：颜色旁边永远要写字，颜色不能是唯一的信息载体 */
  label: string
  /** 一句话说明这一大类包含什么（悬停、空状态用） */
  gloss: string
  /** 内置知识点树一级代码（src/main/seed/taxonomy.ts）；GR 开头的都归语法 */
  codes: string[]
  light: string
  dark: string
}

/** 全局固定，不能挪作他用。第二版：降低饱和度、统一明度，和长春花紫主色协调（琥珀、鼠尾草绿、天蓝、青、兰紫、陶土）。 */
export const CATEGORIES: Category[] = [
  { key: 'phonics', label: '语音', gloss: '字母、字母组合发音、重音和语调', codes: ['PH'], light: '#B98733', dark: '#E0B060' },
  { key: 'vocab', label: '词汇', gloss: '主题词汇、词形变化、短语搭配', codes: ['VO'], light: '#4C9A74', dark: '#6CC49C' },
  { key: 'grammar', label: '语法', gloss: '名词、代词、时态、介词、句型等', codes: ['GR'], light: '#3F86C9', dark: '#6FB0E8' },
  { key: 'communication', label: '交际', gloss: '日常对话与功能用语：问路、购物、打电话', codes: ['FN'], light: '#2C9AA0', dark: '#52C4C8' },
  { key: 'reading', label: '阅读', gloss: '阅读理解与听力理解（理解类）', codes: ['RD', 'LS'], light: '#A062B9', dark: '#C493E0' },
  { key: 'writing', label: '写作', gloss: '写句子、书面表达', codes: ['WR'], light: '#C87B4C', dark: '#EAA079' }
]

export const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c])) as Record<CategoryKey, Category>

/** 知识点代码（如 GR.NOUN.PLURAL、PH.PHONICS.COMBO）属于哪个大类。认不出的返回 null（例如题型代码）。 */
export function categoryOfCode(code: string | null | undefined): CategoryKey | null {
  if (!code) return null
  const head = code.split('.')[0]
  for (const c of CATEGORIES) if (c.codes.includes(head)) return c.key
  return null
}

export const categoryColor = (key: CategoryKey, mode: Mode): string => CATEGORY_BY_KEY[key][mode]

// ───────────────────────────── 对比度工具 ─────────────────────────────

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 对比度（两个不透明 #RRGGBB） */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
/** 把 #RRGGBB 以 alpha 叠在底色上，得到不透明的 #RRGGBB（用来算色块上的文字对比度） */
export function mix(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg)
  const b = parseHex(bg)
  const o = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)))
  return '#' + o.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

// ───────────────────────────── 字体、字号、间距、形状、动效 ─────────────────────────────

/** 西文、数字、音标：Source Sans 3（打包在应用里，完全离线）；中文：系统黑体，不打包中文字体 */
export const fontStack =
  '"Source Sans 3 Variable", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'

/** 字号阶梯。14 是正文，投屏时正文不小于 14；44 只用于总览的大字结论里的数字 */
export const fontSizes = { xs: 13, sm: 14, md: 14, lg: 16, xl: 18, h3: 22, h2: 30, display: 44 } as const

export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64 } as const

/** 形状：卡片 18、控件 12、小块 8；按钮和标签是胶囊（pill）；画布 24 */
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, pill: 999 } as const

/** 版心最大宽度；阅读类内容另设约 68 个汉字的行宽 */
/** 外框：窄图标栏 84px；画布四周留 16px 灰边 */
export const layout = { maxWidth: 1240, readingMeasure: '68em', siderWidth: 84, canvasGap: 16 } as const

export const motion = {
  /** 状态过渡 */
  fast: 150,
  base: 200,
  /** 标志动效：拇指索引「翻页」横向滑入 */
  page: 240,
  /** 指数缓出 */
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)'
} as const

// ───────────────────────────── 1) CSS 变量 ─────────────────────────────

function paletteVars(p: Palette, mode: Mode): string[] {
  const v = (name: string, value: string) => `  --ewb-${name}: ${value};`
  const lines = [
    v('paper', p.paper), v('paper-2', p.paper2), v('page', p.page), v('elevated', p.elevated),
    v('ink', p.ink), v('ink-2', p.ink2), v('placeholder', p.placeholder),
    v('primary', p.primary), v('primary-hover', p.primaryHover), v('primary-active', p.primaryActive), v('primary-soft', p.primarySoft), v('on-primary', p.onPrimary),
    v('red', p.red), v('red-ink', p.redInk), v('red-soft', p.redSoft), v('red-line', p.redLine), v('on-red', p.onRed),
    v('note', p.note), v('line', p.line), v('line-strong', p.lineStrong),
    v('ok', p.ok), v('warn', p.warn), v('mask', p.mask), v('shadow-pop', p.shadowPop),
    v('sheet', p.sheet), v('sheet-ink', p.sheetInk)
  ]
  for (const c of CATEGORIES) {
    const col = c[mode]
    lines.push(v(`cat-${c.key}`, col))
    // 色块的浅底：用于拇指索引标签、横条图底色；文字永远用墨色，保证对比度
    lines.push(v(`cat-${c.key}-soft`, mix(col, p.page, mode === 'light' ? 0.14 : 0.2)))
    lines.push(v(`cat-${c.key}-soft-strong`, mix(col, p.page, mode === 'light' ? 0.3 : 0.38)))
  }
  return lines
}

function staticVars(): string[] {
  const v = (name: string, value: string | number) => `  --ewb-${name}: ${value};`
  return [
    v('font', fontStack),
    ...Object.entries(fontSizes).map(([k, n]) => v(`fs-${k}`, `${n}px`)),
    ...Object.entries(spacing).map(([k, n]) => v(`sp-${k}`, `${n}px`)),
    ...Object.entries(radius).map(([k, n]) => v(`r-${k}`, `${n}px`)),
    v('max-width', `${layout.maxWidth}px`),
    v('reading-measure', layout.readingMeasure),
    v('sider-w', `${layout.siderWidth}px`),
    v('canvas-gap', `${layout.canvasGap}px`),
    v('t-fast', `${motion.fast}ms`),
    v('t-base', `${motion.base}ms`),
    v('t-page', `${motion.page}ms`),
    v('ease', motion.ease)
  ]
}

/** 全部 CSS 变量：:root 是浅色，[data-theme="dark"] 是深色（ThemeProvider 永远写入解析后的 light / dark） */
export function cssVariablesText(): string {
  return [
    // [data-theme-scope] 用于 Gallery 里同屏展示浅色 / 深色两套
    ':root, [data-theme-scope="light"] {', ...paletteVars(palettes.light, 'light'), '  color-scheme: light;', '}',
    ':root {', ...staticVars(), '}',
    ':root[data-theme="dark"], [data-theme-scope="dark"] {', ...paletteVars(palettes.dark, 'dark'), '  color-scheme: dark;', '}'
  ].join('\n')
}

// ───────────────────────────── 2) AntD 主题 ─────────────────────────────

/** AntD 全局 token + 组件 token。目标：界面上看不出默认 AntD。 */
export function antdTheme(mode: Mode): ThemeConfig {
  const p = palettes[mode]
  const dark = mode === 'dark'
  return {
    algorithm: dark ? antdThemeApi.darkAlgorithm : antdThemeApi.defaultAlgorithm,
    token: {
      fontFamily: fontStack,
      fontSize: fontSizes.md,
      fontSizeSM: fontSizes.sm,
      fontSizeLG: fontSizes.lg,
      fontSizeXL: fontSizes.xl,
      fontSizeHeading1: fontSizes.h2,
      fontSizeHeading2: fontSizes.h3,
      fontSizeHeading3: fontSizes.xl,
      fontSizeHeading4: fontSizes.lg,
      fontSizeHeading5: fontSizes.md,
      colorPrimary: p.primary,
      colorPrimaryHover: p.primaryHover,
      colorPrimaryActive: p.primaryActive,
      colorInfo: p.primary,
      colorError: p.red,
      colorErrorText: p.redInk,
      colorErrorHover: p.red,
      colorErrorActive: p.red,
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorLink: p.primary,
      colorLinkHover: p.primaryHover,
      colorLinkActive: p.primaryActive,
      colorBgBase: p.page,
      colorTextBase: p.ink,
      colorBgLayout: p.paper,
      colorBgContainer: p.page,
      colorBgElevated: p.elevated,
      colorBgMask: p.mask,
      colorBgSpotlight: dark ? '#3A3A66' : p.ink,
      colorText: p.ink,
      colorTextSecondary: p.ink2,
      colorTextTertiary: p.ink2,
      colorTextQuaternary: p.placeholder,
      colorTextDescription: p.ink2,
      colorTextHeading: p.ink,
      colorTextPlaceholder: p.placeholder,
      colorTextLightSolid: dark ? '#ECEBF7' : '#FFFFFF',
      colorBorder: p.lineStrong,
      colorBorderSecondary: p.line,
      colorSplit: p.line,
      colorFill: p.primarySoft,
      colorFillSecondary: p.note,
      colorFillTertiary: p.note,
      colorFillQuaternary: p.paper2,
      colorInfoBg: p.note,
      colorInfoBorder: p.line,
      colorErrorBg: p.redSoft,
      colorErrorBorder: p.redLine,
      colorSuccessBg: p.note,
      colorSuccessBorder: p.line,
      colorWarningBg: p.note,
      colorWarningBorder: p.line,
      controlOutline: p.primary,
      controlOutlineWidth: 2,
      lineWidthFocus: 2,
      controlItemBgHover: p.primarySoft,
      controlItemBgActive: p.primarySoft,
      controlItemBgActiveHover: p.primarySoft,
      borderRadius: radius.md,
      borderRadiusSM: radius.sm,
      borderRadiusLG: radius.lg,
      borderRadiusXS: 2,
      controlHeight: 36,
      controlHeightSM: 30,
      controlHeightLG: 42,
      lineWidth: 1,
      wireframe: false,
      boxShadow: p.shadowPop,
      boxShadowSecondary: p.shadowPop,
      boxShadowTertiary: 'none',
      motionDurationFast: `${motion.fast / 1000}s`,
      motionDurationMid: `${motion.base / 1000}s`,
      motionDurationSlow: `${motion.base / 1000}s`,
      motionEaseOut: motion.ease,
      motionEaseInOut: motion.ease
    },
    components: {
      Layout: { bodyBg: p.paper, headerBg: p.paper, siderBg: p.paper2, triggerBg: p.paper2, triggerColor: p.ink2 },
      Button: {
        borderRadius: radius.pill,
        borderRadiusSM: radius.pill,
        borderRadiusLG: radius.pill,
        contentFontSize: 15,
        contentFontSizeSM: 14,
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        primaryColor: p.onPrimary,
        defaultColor: p.ink,
        defaultBg: 'transparent',
        defaultBorderColor: dark ? p.lineStrong : p.ink,
        defaultHoverColor: p.primary,
        defaultHoverBorderColor: p.primary,
        defaultHoverBg: p.primarySoft,
        defaultActiveColor: p.primaryActive,
        defaultActiveBorderColor: p.primaryActive,
        defaultActiveBg: p.primarySoft,
        dangerColor: p.red,
        textHoverBg: p.primarySoft,
        textTextHoverColor: p.primary,
        linkHoverBg: 'transparent',
        paddingInline: 16,
        paddingInlineSM: 12,
        onlyIconSize: 16
      },
      Input: {
        activeBorderColor: p.primary,
        hoverBorderColor: p.primary,
        activeShadow: `0 0 0 1px ${p.primary}`,
        errorActiveShadow: `0 0 0 1px ${p.red}`,
        warningActiveShadow: `0 0 0 1px ${p.warn}`,
        paddingInline: 12,
        addonBg: p.paper2
      },
      InputNumber: { activeBorderColor: p.primary, hoverBorderColor: p.primary, activeShadow: `0 0 0 1px ${p.primary}`, handleBg: p.paper2 },
      Select: {
        activeBorderColor: p.primary,
        hoverBorderColor: p.primary,
        activeOutlineColor: p.primarySoft,
        optionSelectedBg: p.primarySoft,
        optionSelectedColor: p.primary,
        optionSelectedFontWeight: 600,
        optionActiveBg: p.primarySoft,
        selectorBg: p.page,
        multipleItemBg: p.note,
        multipleItemBorderColor: p.line,
        clearBg: p.page
      },
      TreeSelect: { nodeSelectedBg: p.primarySoft, nodeHoverBg: p.primarySoft },
      Tree: { nodeSelectedBg: p.primarySoft, nodeHoverBg: p.primarySoft, directoryNodeSelectedBg: p.primarySoft, directoryNodeSelectedColor: p.primary },
      Table: {
        headerBg: 'transparent',
        headerColor: p.ink2,
        headerSplitColor: 'transparent',
        headerSortActiveBg: p.note,
        headerSortHoverBg: p.note,
        headerBorderRadius: 0,
        borderColor: p.line,
        rowHoverBg: p.primarySoft,
        rowSelectedBg: p.primarySoft,
        rowSelectedHoverBg: p.primarySoft,
        rowExpandedBg: p.paper2,
        cellPaddingBlock: 12,
        cellPaddingInline: 14,
        cellFontSize: fontSizes.md,
        cellFontSizeMD: fontSizes.md,
        fontWeightStrong: 600,
        stickyScrollBarBg: p.lineStrong,
        footerBg: p.paper2,
        bodySortBg: 'transparent'
      },
      Tabs: {
        inkBarColor: p.primary,
        itemColor: p.ink2,
        itemHoverColor: p.primary,
        itemSelectedColor: p.primary,
        itemActiveColor: p.primaryActive,
        titleFontSize: 15,
        horizontalItemGutter: 28,
        horizontalMargin: '0 0 16px 0',
        cardBg: p.paper2,
        cardGutter: 4
      },
      Modal: {
        titleFontSize: fontSizes.xl,
        titleColor: p.ink,
        contentBg: p.elevated,
        headerBg: p.elevated,
        footerBg: p.elevated,
        borderRadiusLG: radius.lg
      },
      Drawer: { colorBgElevated: p.elevated, footerPaddingBlock: 12, footerPaddingInline: 20 },
      Tag: {
        defaultBg: p.note,
        defaultColor: p.ink2,
        borderRadiusSM: radius.pill,
        fontSizeSM: fontSizes.xs,
        lineHeightSM: 1.5
      },
      Tooltip: { colorBgSpotlight: dark ? '#3A3A66' : p.ink, colorTextLightSolid: dark ? '#ECEBF7' : '#FFFFFF', borderRadius: radius.md },
      Popover: { colorBgElevated: p.elevated, titleMinWidth: 0 },
      Message: { contentBg: p.elevated, contentPadding: '10px 16px' },
      Notification: { colorBgElevated: p.elevated },
      Switch: { colorPrimary: p.primary, colorPrimaryHover: p.primaryHover, handleBg: dark ? p.paper : '#FFFFFF', colorTextQuaternary: p.lineStrong, colorTextTertiary: p.lineStrong },
      Menu: {
        itemBg: 'transparent',
        itemColor: p.ink,
        itemHoverBg: p.primarySoft,
        itemHoverColor: p.primary,
        itemSelectedBg: p.primarySoft,
        itemSelectedColor: p.primary,
        itemActiveBg: p.primarySoft,
        itemBorderRadius: radius.sm,
        itemMarginInline: 4,
        activeBarBorderWidth: 0,
        subMenuItemBg: 'transparent',
        popupBg: p.elevated,
        dropdownWidth: 160
      },
      Dropdown: { paddingBlock: 6, colorBgElevated: p.elevated },
      Segmented: {
        trackBg: p.note,
        itemSelectedBg: p.page,
        itemSelectedColor: p.primary,
        itemColor: p.ink2,
        itemHoverBg: 'transparent',
        itemHoverColor: p.primary,
        trackPadding: 2,
        borderRadius: radius.pill,
        borderRadiusSM: radius.pill,
        borderRadiusLG: radius.pill
      },
      Alert: { borderRadiusLG: radius.lg, defaultPadding: '8px 14px', withDescriptionPadding: '12px 16px' },
      Card: { borderRadiusLG: radius.lg, headerBg: 'transparent', headerFontSize: fontSizes.lg, colorBorderSecondary: p.line, boxShadowTertiary: 'none', actionsBg: p.paper2 },
      Collapse: { headerBg: p.paper2, contentBg: p.page, borderRadiusLG: radius.lg },
      Statistic: { titleFontSize: fontSizes.sm, contentFontSize: fontSizes.h3 },
      Steps: { colorPrimary: p.primary, iconSize: 28, titleLineHeight: 28 },
      Progress: { remainingColor: p.line, defaultColor: p.primary },
      Checkbox: { colorPrimary: p.primary, colorPrimaryHover: p.primaryHover, colorBgContainer: p.page, borderRadiusSM: 3 },
      Radio: { colorPrimary: p.primary, buttonSolidCheckedBg: p.primary, buttonSolidCheckedColor: p.onPrimary, buttonCheckedBg: p.page, buttonColor: p.ink },
      Form: { labelColor: p.ink2, itemMarginBottom: 20, verticalLabelPadding: '0 0 6px' },
      Divider: { colorSplit: p.line },
      Badge: { dotSize: 8, textFontSize: 12 },
      Pagination: { itemActiveBg: p.page, itemBg: 'transparent', itemActiveColorDisabled: p.ink2 },
      Empty: { colorTextDescription: p.ink2 },
      Skeleton: { gradientFromColor: p.note, gradientToColor: p.paper2 },
      Spin: { colorPrimary: p.primary },
      List: { itemPadding: '10px 0', colorSplit: p.line },
      Descriptions: { labelBg: p.paper2, colorSplit: p.line },
      Upload: { colorBorder: p.lineStrong },
      Slider: { trackBg: p.primary, trackHoverBg: p.primaryHover, handleColor: p.primary, handleActiveColor: p.primaryActive, railBg: p.line, railHoverBg: p.line }
    }
  }
}

// ───────────────────────────── 3) ECharts 主题 ─────────────────────────────

/** ECharts 主题对象（不依赖 echarts 包本身，项目目前用纯 DOM 画 treemap；引入 echarts 后调用 registerEChartsThemes 即可） */
export function echartsTheme(mode: Mode): Record<string, unknown> {
  const p = palettes[mode]
  const axis = {
    axisLine: { lineStyle: { color: p.lineStrong } },
    axisTick: { lineStyle: { color: p.lineStrong } },
    axisLabel: { color: p.ink2, fontSize: fontSizes.sm },
    splitLine: { lineStyle: { color: p.line, type: 'solid' } },
    nameTextStyle: { color: p.ink2 }
  }
  return {
    // 系列颜色按大类固定顺序：语音、词汇、语法、交际、阅读、写作
    color: CATEGORIES.map(c => c[mode]),
    backgroundColor: 'transparent',
    textStyle: { fontFamily: fontStack, color: p.ink, fontSize: fontSizes.md },
    title: { textStyle: { color: p.ink, fontSize: fontSizes.lg, fontWeight: 600 }, subtextStyle: { color: p.ink2 } },
    legend: { textStyle: { color: p.ink2, fontSize: fontSizes.sm } },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    categoryAxis: axis,
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    bar: { barMaxWidth: 14, itemStyle: { borderRadius: [0, 7, 7, 0] } },
    tooltip: {
      backgroundColor: p.elevated,
      borderColor: p.line,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: p.ink, fontSize: fontSizes.sm, fontFamily: fontStack },
      extraCssText: `box-shadow: ${p.shadowPop}; border-radius: ${radius.md}px;`
    },
    // 热力 / 矩形树图：单一词头蓝的深浅
    visualMap: { inRange: { color: [mix(p.primary, p.page, 0.12), p.primary] }, textStyle: { color: p.ink2 } },
    treemap: { itemStyle: { borderColor: p.page, borderWidth: 2, gapWidth: 2 }, label: { color: p.onPrimary } }
  }
}

/** 注册 ewb-light / ewb-dark。传入 `import * as echarts from 'echarts'`。 */
export function registerEChartsThemes(echarts: { registerTheme: (name: string, theme: object) => void }): void {
  echarts.registerTheme('ewb-light', echartsTheme('light'))
  echarts.registerTheme('ewb-dark', echartsTheme('dark'))
}

export const echartsThemeName = (mode: Mode): 'ewb-light' | 'ewb-dark' => (mode === 'dark' ? 'ewb-dark' : 'ewb-light')
