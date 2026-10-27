import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import { z } from 'zod'
import { getMainWindow } from '../window'
import { matrixToCsv } from '../stats/csv'
import { describeFilter } from '../stats/p2'
import { getDb } from '../db'
import { StatsFilterSchema, LevelSchema, paperScope } from '../stats/filter'
import * as S from '../stats/core'
import { analysisState, cancelAnalysis, generateAnalysis } from '../stats/analysis'
import { cancelReport } from '../report/service'
import { cancelKpAnalysis, generateKpAnalysis, kpAnalysisState } from '../stats/kp-analysis'
import type { KpScope } from '../stats/kp-analysis'
import type { AnalysisScope } from '../stats/analysis'

const yearNum = z.number().int().min(2000).max(2100)
// 同比的基线：'before' = 目标学年之前的全部学年；数字 = 只看某一学年
const BaseSchema = z.union([z.literal('before'), yearNum])
const FilterArg = StatsFilterSchema.default({})
const CodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/).max(80)

const baseSpec = (target: number, base: z.infer<typeof BaseSchema>) => (base === 'before' ? { lt: target } : { eq: base })

const ScopeSchema = z.object({ filter: FilterArg, target: yearNum, base: BaseSchema, level: LevelSchema.default(2), align: z.boolean().default(true) })
const toScope = (raw: unknown): AnalysisScope => {
  const s = ScopeSchema.parse(raw)
  // 同比自己决定学年：筛选里的学年在这里不生效，必须剔除——否则它会混进缓存的范围键，换个学年筛选就让 AI 分析「消失」
  const { school_year_start: _ignored, ...filter } = s.filter
  return { filter, target: s.target, base: baseSpec(s.target, s.base), level: s.level, align: s.align }
}

// 看板抽屉里「只讲这一个考点」的 AI 分析：code 必填；从同比页打开时带上 target / base（今年 / 去年及以前），否则只讲筛选范围内的情况
const KpScopeSchema = z.object({ filter: FilterArg, code: CodeSchema, target: yearNum.nullish(), base: BaseSchema.nullish(), align: z.boolean().default(true) })
const toKpScope = (raw: unknown): KpScope => {
  const s = KpScopeSchema.parse(raw)
  const { school_year_start: _ignored, ...filter } = s.filter
  const hasYear = s.target != null && s.base != null
  return { filter: hasYear ? filter : s.filter, code: s.code, target: hasYear ? s.target! : null, base: hasYear ? baseSpec(s.target!, s.base!) : null, align: s.align }
}

export function registerStatsIpc(): void {
  const db = () => getDb()
  ipcMain.handle('stats:overview', async (_e, filter?: unknown) => S.overview(db(), FilterArg.parse(filter ?? {})))
  ipcMain.handle('stats:distribution', async (_e, filter?: unknown) => S.distribution(db(), FilterArg.parse(filter ?? {})))
  ipcMain.handle('stats:matrix', async (_e, filter?: unknown, level?: unknown) => S.matrix(db(), FilterArg.parse(filter ?? {}), LevelSchema.default(1).parse(level)))
  ipcMain.handle('stats:hot', async (_e, filter?: unknown, level?: unknown) => S.hot(db(), FilterArg.parse(filter ?? {}), LevelSchema.default(2).parse(level)))
  // 每个页面都显示的「范围说明」：待审核没计入几份、重复导入怎么处理的、没填学年几份。只做计数，很轻
  ipcMain.handle('stats:notes', async (_e, filter?: unknown) => S.scopeNotes(db(), FilterArg.parse(filter ?? {})))
  ipcMain.handle('stats:compare', async (_e, filter: unknown, target: unknown, base: unknown, level?: unknown, align?: unknown) => {
    const t = yearNum.parse(target)
    // 界面的四栏不需要样本题（抽屉里单独取），不取样本能省下一大半时间；P2 自己另调 compare 取样本
    return S.compare(db(), FilterArg.parse(filter ?? {}), t, baseSpec(t, BaseSchema.parse(base)), LevelSchema.default(2).parse(level), 0, z.boolean().default(true).parse(align))
  })
  /** 导出双向细目表：弹出系统的「另存为」，写 CSV（带 BOM，Excel 直接打开） */
  ipcMain.handle('stats:exportMatrix', async (_e, filter?: unknown, level?: unknown) => {
    const lv = LevelSchema.default(1).parse(level)
    const f = FilterArg.parse(filter ?? {})
    const csv = matrixToCsv(S.matrix(db(), f, lv), describeFilter(f, lv))
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = {
      title: '导出双向细目表', defaultPath: `双向细目表-${['', '一级', '二级', '三级'][lv]}知识点.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    try {
      fs.writeFileSync(r.filePath, csv, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用（比如 Excel 里还开着它）或没有写入权限，请关闭后重试' : `保存失败：${(e as Error).message}`)
    }
    return { saved: true, path: r.filePath, bytes: Buffer.byteLength(csv) }
  })
  ipcMain.handle('stats:filterOptions', async (_e, filter?: unknown) => S.filterOptions(db(), filter === undefined ? undefined : FilterArg.parse(filter)))

  /** 抽屉里的题目卡片：某知识点（含子树）在目标侧 / 基线侧 / 当前筛选范围内的题目 */
  ipcMain.handle('stats:questions', async (_e, rawFilter: unknown, rawSide: unknown, rawCode: unknown, rawLimit?: unknown) => {
    const filter = FilterArg.parse(rawFilter ?? {})
    const side = z.union([
      z.object({ kind: z.literal('year'), year: yearNum }),
      // 同比的基线侧：与同比四栏用同一个「对齐后的基线范围」（sideScopes），抽屉里的卡片数 = 表格上的「基线 x/y 份」
      z.object({ kind: z.literal('base'), target: yearNum, base: BaseSchema, align: z.boolean().default(true) }),
      z.object({ kind: z.literal('filter') })
    ]).parse(rawSide)
    const scope = S.drawerScope(db(), filter, side)
    return S.questionsOfKp(db(), scope, CodeSchema.parse(rawCode), z.number().int().min(1).max(100).default(30).parse(rawLimit))
  })

  // ── P2 同比分析（流式输出走 ai:chunk，只发给发起请求的窗口） ──
  ipcMain.handle('ai:compareAnalysis', async (_e, raw: unknown) => analysisState(toScope(raw)))
  ipcMain.handle('ai:analyzeCompare', async (e, raw: unknown, rawRequestId: unknown) => {
    const scope = toScope(raw)
    const requestId = z.string().uuid().parse(rawRequestId)
    const sender = e.sender
    return generateAnalysis(scope, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })
  // ── 单个考点的 AI 分析（抽屉）：只读状态不花钱；生成走 ai:chunk，取消用 ai:cancel ──
  ipcMain.handle('ai:kpAnalysis', async (_e, raw: unknown) => kpAnalysisState(toKpScope(raw)))
  ipcMain.handle('ai:analyzeKp', async (e, raw: unknown, rawRequestId: unknown) => {
    const scope = toKpScope(raw)
    const requestId = z.string().uuid().parse(rawRequestId)
    const sender = e.sender
    return generateKpAnalysis(scope, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })
  ipcMain.handle('ai:cancel', async (_e, rawRequestId: unknown) => {
    const id = z.string().uuid().parse(rawRequestId)
    return cancelAnalysis(id) || cancelReport(id) || cancelKpAnalysis(id)   // P2 分析、P3 报告、单个考点分析共用同一个取消入口
  })
}
