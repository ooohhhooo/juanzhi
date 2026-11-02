/**
 * 导出卡片（口诀大招 / 答题卡）的样式常量与静态 CSS。纯模块，应用界面、PDF、复制成图片、Word 都从这里取色，避免四处各写一份而走样。
 *
 * 「卡片色」是 DESIGN.md 里记录在案的一个例外：口诀卡需要琥珀，但琥珀是「语音」大类的专用色。
 * 所以这里单独定义 card-amber 一组令牌（仅用于导出卡片，不用于应用界面，不与大类色混用）；tokens.ts 从这里读取并展开成 CSS 变量。
 * 卡片永远是白纸（和原卷一样，不随深色主题变）；深色那一套给「深色界面里围着卡片的描边和说明文字」用，对比度同样 ≥ 7:1。
 */
export const CARD_WIDTH = 720
export const CARD_RADIUS = 18

export interface CardAmber {
  /** 横幅底色（淡琥珀） */
  band: string
  /** 横幅文字（墨色偏琥珀）：在 band 上对比度 ≥ 7:1 */
  ink: string
  /** 卡片外框 / 虚线框 */
  line: string
}

export const CARD_AMBER: { light: CardAmber; dark: CardAmber } = {
  light: { band: '#FFF1CC', ink: '#4A3200', line: '#C79A3B' },
  // 深色：深琥珀底 + 浅琥珀字（在 #1D1D35 画布和 band 上都 ≥ 7:1）
  dark: { band: '#3A2D0C', ink: '#FFE2A0', line: '#B98733' }
}

/** 卡片自己的纸色与墨色（白纸，不随主题变） */
export const CARD_PAPER = { paper: '#FFFFFF', ink: '#1C1B2E', ink2: '#5E5D75', line: '#D9D8E6', lineStrong: '#8D8CA6', badge: '#1C1B2E', onBadge: '#FFFFFF' } as const

/** WCAG 对比度（#RRGGBB），单测用 */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16)
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const FONT = '"Source Sans 3 Variable", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif'

/**
 * 静态页面（PDF / 复制成图片）里卡片的 CSS。不依赖任何变量和外部字体；尺寸用 px（图片按 720px 宽排版），
 * 打印到 A4 时卡片 max-width: 100% 自动收窄。
 */
export function cardCss(): string {
  const a = CARD_AMBER.light
  const p = CARD_PAPER
  return `
.ewb-card { box-sizing: border-box; width: ${CARD_WIDTH}px; max-width: 100%; margin: 12px 0; background: ${p.paper}; color: ${p.ink}; border: 1px solid ${a.line}; border-radius: ${CARD_RADIUS}px; overflow: hidden; font-family: ${FONT}; page-break-inside: avoid; }
.ewb-card--answer { border-color: ${p.lineStrong}; }
.ewb-card__band { background: ${a.band}; color: ${a.ink}; font-size: 14px; font-weight: 600; padding: 9px 22px; letter-spacing: .5px; }
.ewb-card--answer .ewb-card__band { background: ${p.paper}; color: ${p.ink}; border-bottom: 1px solid ${p.line}; display: flex; justify-content: space-between; }
.ewb-card__body { padding: 18px 22px 14px; }
.ewb-trick__main { font-size: 22px; font-weight: 700; line-height: 1.5; margin: 0 0 10px; }
.ewb-trick__eg { font-size: 16px; line-height: 1.6; margin: 0 0 8px; color: ${p.ink}; }
.ewb-trick__eg i { font-style: italic; }
.ewb-trick__from { font-size: 13px; color: ${p.ink2}; margin: 0; }
.ewb-card__foot { font-size: 13px; color: ${p.ink2}; padding: 8px 22px 12px; border-top: 1px solid ${p.line}; }
.ewb-ans__who { display: flex; gap: 28px; font-size: 15px; padding: 14px 22px 4px; }
.ewb-ans__who span { flex: 1; }
.ewb-ans__line { display: inline-block; width: 150px; border-bottom: 1px solid ${p.ink}; height: 1em; vertical-align: baseline; margin-left: 4px; }
.ewb-ans__item { display: flex; gap: 14px; padding: 12px 22px; }
.ewb-ans__item + .ewb-ans__item { border-top: 1px solid ${p.line}; }
.ewb-ans__no { flex: none; width: 28px; height: 28px; line-height: 28px; border-radius: 50%; background: ${p.badge}; color: ${p.onBadge}; text-align: center; font-size: 15px; font-weight: 700; }
.ewb-ans__stem { font-size: 17px; line-height: 1.6; margin: 0 0 8px; }
.ewb-ans__opts { display: flex; flex-wrap: wrap; gap: 6px 26px; font-size: 16px; margin: 0; }
.ewb-ans__opts span { white-space: nowrap; }
.ewb-ans__box { border: 1.5px dashed ${p.lineStrong}; border-radius: 10px; height: 44px; margin-top: 4px; }
.ewb-ans__box + .ewb-ans__box { margin-top: 8px; }
`
}
