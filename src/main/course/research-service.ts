/**
 * 教研对照表的主进程部分（需要 electron）：修订建议的 AI 小结。
 * 程序规则已经算好依据（research-table.ts），这里每节课调用一次用户配置的 AI，把依据写成一两句话；
 * 回答不合格（编了数字、不是 JSON 等）就丢掉，只保留规则结论。课件文字只发给用户配置的 AI，不含学员信息。
 * 只在老师点按钮时调用（界面先告诉调用次数、可取消）；导出 Excel 直接用界面上已有的小结，不再调 AI。
 */
import crypto from 'node:crypto'
import { loadConfig } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { parseModelOf } from '../ai/types'
import { AiError } from '../ai/client'
import { log } from '../log'
import { mapLimit } from './map-limit'
import { jsonCall } from './service'
import { coursewareOfLesson, lessonKey } from './courseware'
import { AI_ADVICE_SYSTEM, MAX_AI_LESSONS, buildAdviceUser, parseAdviceReply } from './research-ai'
import type { ResearchTable } from './research-table'

export const aiConfigured = (): boolean => { const c = loadConfig(); return !!(c.base_url && parseModelOf(c) && getApiKey()) }

/** 将要调用 AI 的次数（每节有建议的课一次，最多 MAX_AI_LESSONS 节） */
export function adviceCallCount(table: ResearchTable): { calls: number; total: number } {
  const total = table.lessons.filter(l => l.advice.length > 0).length
  return { calls: Math.min(total, MAX_AI_LESSONS), total }
}

/** 兜底缓存：同一节课、同样的依据和课件摘录，不重复调 AI（进程内，最多 500 条） */
const cache = new Map<string, string>()
const CACHE_MAX = 500

export interface PolishResult { summaries: Record<string, string>; done: number; failed: number; cancelled: boolean; model: string; note: string }

/**
 * 给有建议的课写 AI 小结。结果同时写进 table.lessons[i].aiAdvice，并按「级别|课次」返回（界面存在组件状态里，导出时带回来）。
 * 没配 AI / 出错都不影响规则结论；signal 中止后立刻停，已写好的保留。
 */
export async function polishAdvice(table: ResearchTable, dataDir: string, signal?: AbortSignal): Promise<PolishResult> {
  const res: PolishResult = { summaries: {}, done: 0, failed: 0, cancelled: false, model: '', note: '' }
  if (!table.ready) return res
  if (!aiConfigured()) return { ...res, note: '还没有配置 AI 服务，只给出了规则结论' }
  const model = parseModelOf(loadConfig())
  res.model = model
  const withAdvice = table.lessons.filter(l => l.advice.length > 0)
  const todo = withAdvice.slice(0, MAX_AI_LESSONS)
  const skipped = withAdvice.length - todo.length
  const done = (l: (typeof todo)[number], s: string) => { l.aiAdvice = s; res.summaries[lessonKey(l.levelName, l.seq)] = s; res.done++ }
  try {
    await mapLimit(todo, 3, async l => {
      if (signal?.aborted) throw new AiError('aborted', '已取消')
      const cw = coursewareOfLesson(dataDir, l.outlineId, lessonKey(l.levelName, l.seq)).map(c => c.text).join('\n')
      const user = buildAdviceUser(l, cw)
      const ck = crypto.createHash('sha1').update(`${l.outlineId}|${lessonKey(l.levelName, l.seq)}|${model}|${user}`).digest('hex')
      const hit = cache.get(ck)
      if (hit) { done(l, hit); return }
      try {
        const r = await jsonCall({ kind: 'research-advice', model, system: AI_ADVICE_SYSTEM, user, signal })
        const s = parseAdviceReply(r.content, l)
        if (s) {
          done(l, s)
          cache.set(ck, s)
          while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
        } else res.failed++
      } catch (e) {
        if (e instanceof AiError && e.code === 'aborted') throw e
        res.failed++
      }
    })
  } catch (e) {
    if (e instanceof AiError && e.code === 'aborted') res.cancelled = true
    else throw e
  }
  log.info('course', '教研对照表 AI 小结', { lessons: todo.length, done: res.done, failed: res.failed, cancelled: res.cancelled })
  const notes: string[] = []
  if (res.cancelled) notes.push(`已取消，已写好 ${res.done} 节的小结`)
  if (res.failed) notes.push(`${res.failed} 节课的小结没写成，只保留了规则结论`)
  if (skipped > 0) notes.push(`有建议的课共 ${withAdvice.length} 节，一次最多写前 ${MAX_AI_LESSONS} 节，其余 ${skipped} 节只有规则结论`)
  res.note = notes.join('；')
  return res
}
