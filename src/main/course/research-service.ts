/**
 * 教研对照表的主进程部分（需要 electron）：修订建议的 AI 小结。
 * 程序规则已经算好依据（research-table.ts），这里每节课调用一次用户配置的 AI，把依据写成一两句话；
 * 回答不合格（编了数字、不是 JSON 等）就丢掉，只保留规则结论。课件文字只发给用户配置的 AI，不含学员信息。
 */
import { loadConfig } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { parseModelOf } from '../ai/types'
import { AiError } from '../ai/client'
import { log } from '../log'
import { mapLimit } from './map-limit'
import { jsonCall } from './service'
import { coursewareOfLesson, lessonKey } from './courseware'
import { AI_ADVICE_SYSTEM, buildAdviceUser, parseAdviceReply } from './research-ai'
import type { ResearchTable } from './research-table'

export const aiConfigured = (): boolean => { const c = loadConfig(); return !!(c.base_url && parseModelOf(c) && getApiKey()) }

/** 给有建议的课写 AI 小结（原地写进 table.lessons[i].aiAdvice）。没配 AI / 出错都不影响规则结论 */
export async function polishAdvice(table: ResearchTable, dataDir: string, signal?: AbortSignal): Promise<{ done: number; failed: number; model: string; note: string }> {
  if (!table.ready) return { done: 0, failed: 0, model: '', note: '' }
  if (!aiConfigured()) return { done: 0, failed: 0, model: '', note: '还没有配置 AI 服务，只给出了规则结论' }
  const model = parseModelOf(loadConfig())
  const todo = table.lessons.filter(l => l.advice.length > 0).slice(0, 60)
  let failed = 0, done = 0
  await mapLimit(todo, 3, async l => {
    if (signal?.aborted) return
    const cw = coursewareOfLesson(dataDir, l.outlineId, lessonKey(l.levelName, l.seq)).map(c => c.text).join('\n')
    try {
      const r = await jsonCall({ kind: 'research-advice', model, system: AI_ADVICE_SYSTEM, user: buildAdviceUser(l, cw), signal, maxTokens: 600 })
      const s = parseAdviceReply(r.content, l)
      if (s) { l.aiAdvice = s; done++ } else failed++
    } catch (e) {
      if (e instanceof AiError && e.code === 'aborted') throw e
      failed++
    }
  })
  log.info('course', '教研对照表 AI 小结', { lessons: todo.length, done, failed })
  return { done, failed, model, note: failed ? `${failed} 节课的小结没写成，只保留了规则结论` : '' }
}
