export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? '—' : `${(Math.round(v * 10 ** (digits + 2)) / 10 ** digits).toString()}%`)
export const yearText = (y: number | null | undefined) => (y ? `${y}-${y + 1}学年` : '未填学年')
export const num = (v: number) => (Math.round(v * 100) / 100).toString()
export const LEVEL_LABEL = ['', '一级', '二级', '三级']
export const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const DIFF_LABEL = ['', '很容易', '较容易', '中等', '较难', '很难']
