/**
 * 卷卷（卷知的卷轴吉祥物）的像素画：10 × 10 个像素，用半块字符（▀ ▄ █）两行像素拼成一行字符，共 5 行 × 10 列。
 * 奶油色身体、蓝紫色（和界面主色一致）的两头卷轴、深色眼睛和嘴。纯数据 + 纯函数，不依赖 Ink，单测直接加载。
 */
export const PX = { c: '#F5E6C8', p: '#8F94FF', k: '#2B2D55' } as const

/** . 空；c 奶油；p 蓝紫；k 深色（眼、嘴） */
export const MASCOT_GRID = [
  '..pppppp..',
  '.pppppppp.',
  '.cccccccc.',
  '.cckcckcc.',
  '.cccccccc.',
  '.ccckkccc.',
  '.cccccccc.',
  '.pppppppp.',
  '..pppppp..',
  '..cc..cc..'
]

export interface Cell { ch: string; fg?: string; bg?: string }

const color = (px: string): string | undefined => (px === '.' ? undefined : PX[px as keyof typeof PX])

/** 带颜色的 5 行：上半像素做前景（▀），下半像素做背景；只有下半像素时用 ▄ */
export function mascotRows(): Cell[][] {
  const rows: Cell[][] = []
  for (let y = 0; y < MASCOT_GRID.length; y += 2) {
    const row: Cell[] = []
    for (let x = 0; x < MASCOT_GRID[y].length; x++) {
      const top = color(MASCOT_GRID[y][x]), bot = color(MASCOT_GRID[y + 1][x])
      if (top && bot) row.push(top === bot ? { ch: '█', fg: top } : { ch: '▀', fg: top, bg: bot })
      else if (top) row.push({ ch: '▀', fg: top })
      else if (bot) row.push({ ch: '▄', fg: bot })
      else row.push({ ch: ' ' })
    }
    rows.push(row)
  }
  return rows
}

/** 没有颜色时（NO_COLOR）的样子：有像素的地方画块，眼睛和嘴留空 */
export function mascotPlain(): string[] {
  const filled = (px: string): boolean => px !== '.' && px !== 'k'
  const out: string[] = []
  for (let y = 0; y < MASCOT_GRID.length; y += 2) {
    let line = ''
    for (let x = 0; x < MASCOT_GRID[y].length; x++) {
      const t = filled(MASCOT_GRID[y][x]), b = filled(MASCOT_GRID[y + 1][x])
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
    }
    out.push(line)
  }
  return out
}
