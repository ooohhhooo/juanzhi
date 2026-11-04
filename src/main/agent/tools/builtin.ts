/**
 * 内置工具：计划清单、向用户提问、加载剧本。所有角色都有。
 */
import { z } from 'zod'
import { stateIndex } from '../context.ts'
import type { ToolDef } from '../types.ts'

export const updatePlan: ToolDef = {
  name: 'update_plan', label: '写计划', planSafe: true,
  level: 'read',
  description: '维护你的工作计划清单（界面上会显示给用户）。事情要分几步做时，先列出全部步骤；每做完一步再调用一次，更新各步骤的状态。每次都要传完整清单。',
  schema: z.object({
    items: z.array(z.object({
      content: z.string().min(1).max(100).describe('这一步要做什么，一句话'),
      status: z.enum(['todo', 'doing', 'done']).describe('todo 没开始，doing 正在做，done 做完了')
    })).min(1).max(12)
  }),
  run: (args, ctx) => {
    ctx.setPlan(args.items)
    return { text: `计划已更新（${args.items.filter((i: any) => i.status === 'done').length}/${args.items.length} 已完成）`, count: args.items.length }
  }
}

export const askUser: ToolDef = {
  name: 'ask_user', label: '向你提问', planSafe: true,
  level: 'read',
  description: '遇到只有用户能决定的事（比如范围、侧重点）时，暂停并向用户提问，界面会显示问题和选项按钮。返回用户选的答案。',
  schema: z.object({
    question: z.string().min(1).max(200).describe('要问用户的问题，一句大白话'),
    options: z.array(z.string().min(1).max(40)).min(2).max(4).describe('2 到 4 个可选答案'),
    allowOther: z.boolean().default(true).describe('是否允许用户自己写别的答案')
  }),
  run: async (args, ctx) => {
    const a = await ctx.ask({ question: args.question, options: args.options, allowOther: args.allowOther })
    return { text: `用户的回答：${a}`, count: 1 }
  }
}

export const loadPlaybook: ToolDef = {
  name: 'load_playbook', label: '读取分析步骤', planSafe: true,
  level: 'read',
  description: '读取一份 Skill（分析方法说明）的全文。Skill 的名字和用途见 system 里的「可用 Skill」。',
  schema: z.object({ name: z.string().min(1).max(60).describe('Skill 名，和「可用 Skill」里的完全一致') }),
  run: (args, ctx) => {
    const p = ctx.playbook(args.name)
    if (!p) return { text: `没有叫「${args.name}」的 Skill。现有的 Skill：${ctx.playbookNames().join('、') || '（无）'}`, count: 0 }
    return { text: `# ${p.name}\n${p.body}`, count: 1 }
  }
}

export const sessionState: ToolDef = {
  name: 'session_state', label: '取回进度', planSafe: true,
  level: 'read',
  description: '取回这次对话的进度：当前计划、已经做过的查询（带编号和结论）、用户做过的选择。前面的内容被整理成摘要后，需要原文时用它。传 query 编号可以取回某次查询的完整结果。',
  schema: z.object({
    part: z.enum(['all', 'plan', 'queries', 'choices']).default('all').describe('要哪一部分，默认全部'),
    query: z.number().int().min(1).optional().describe('查询编号：取回这次查询的完整结果')
  }),
  run: (args, ctx) => {
    const st = ctx.state()
    if (args.query !== undefined) {
      const q = st.queries.find(x => x.n === args.query)
      return q ? { text: `查询 #${q.n} ${q.name} ${q.args}\n${q.text}`, count: 1 } : { text: `没有编号 #${args.query} 的查询。现有编号：${st.queries.map(x => x.n).join('、') || '（无）'}`, count: 0 }
    }
    const only: typeof st = { plan: args.part === 'all' || args.part === 'plan' ? st.plan : [], queries: args.part === 'all' || args.part === 'queries' ? st.queries : [], choices: args.part === 'all' || args.part === 'choices' ? st.choices : [] }
    return { text: stateIndex(only) || '还没有计划、查询记录或选择。', count: only.queries.length + only.choices.length + only.plan.length }
  }
}

// ───────── 以前的对话（跨对话记忆） ─────────
const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }
const turnsOf = (db: any, sid: string): Array<{ q: string; a: string }> => {
  const rows = db.prepare("SELECT kind, payload_json FROM agent_steps WHERE session_id = ? AND kind IN ('user','answer') ORDER BY seq").all(sid) as any[]
  const out: Array<{ q: string; a: string }> = []
  for (const r of rows) {
    let p: any = {}
    try { p = JSON.parse(r.payload_json) } catch { /* 空 */ }
    if (r.kind === 'user') out.push({ q: String(p.text ?? ''), a: '' })
    else if (out.length) out[out.length - 1].a = String(p.text ?? '')
  }
  return out
}

export const historySearch: ToolDef = {
  name: 'history_search', label: '翻以前的对话', planSafe: true,
  level: 'read',
  description: '在用户以前和你的对话里找内容（问题和你的回答都会搜）。用户说「之前那个……」「上次你写的……」「另一个窗口里的……」，或提到这次对话里没有的东西时，先用它找，再用 history_read 读全文。query 写关键词，空格分隔多个词；不写 query 就列出最近的对话。',
  schema: z.object({ query: z.string().max(80).default('').describe('关键词，空格分隔；留空 = 最近的对话'), limit: z.number().int().min(1).max(20).default(8) }),
  run: (args, ctx) => {
    const words = String(args.query ?? '').split(/\s+/).map((w: string) => w.trim()).filter(Boolean).slice(0, 6)
    const sessions = ctx.db.prepare('SELECT id, title, role, updated_at FROM agent_sessions WHERE id <> ? ORDER BY updated_at DESC LIMIT 200').all(ctx.sessionId) as any[]
    const hits: string[] = []
    for (const s of sessions) {
      if (hits.length >= (args.limit ?? 8)) break
      const turns = turnsOf(ctx.db, s.id)
      if (!words.length) { hits.push(`- 对话 ${s.id}｜${s.updated_at.slice(0, 16)}｜${clip(s.title || turns[0]?.q || '', 40)}｜${turns.length} 轮`); continue }
      const hay = (s.title + '\n' + turns.map(t => t.q + '\n' + t.a).join('\n')).toLowerCase()
      const score = words.filter((w: string) => hay.includes(w.toLowerCase())).length
      if (!score) continue
      const t = turns.find(x => words.some((w: string) => (x.q + x.a).toLowerCase().includes(w.toLowerCase())))
      hits.push(`- 对话 ${s.id}｜${s.updated_at.slice(0, 16)}｜${clip(s.title, 40)}｜命中 ${score}/${words.length} 个词${t ? `｜问：${clip(t.q, 40)}｜答：${clip(t.a, 80)}` : ''}`)
    }
    if (!hits.length) return { text: words.length ? `以前的对话里没有找到「${words.join(' ')}」。可以换个说法，或不写 query 列出最近的对话。` : '还没有以前的对话。', count: 0 }
    return { text: hits.join('\n'), count: hits.length }
  }
}

export const historyRead: ToolDef = {
  name: 'history_read', label: '读以前的对话', planSafe: true,
  level: 'read',
  description: '读一段以前的对话：每一轮用户的问题和你的最终回答（不含中间查询过程）。sessionId 来自 history_search。',
  schema: z.object({ sessionId: z.string().min(1).max(80) }),
  run: (args, ctx) => {
    const s = ctx.db.prepare('SELECT id, title, updated_at FROM agent_sessions WHERE id = ?').get(args.sessionId) as any
    if (!s) return { text: '找不到这个对话，请先用 history_search 找编号。', count: 0 }
    const turns = turnsOf(ctx.db, s.id)
    let left = 12000
    const parts: string[] = []
    for (const [i, t] of turns.entries()) {
      const block = `## 第 ${i + 1} 轮\n用户：${t.q}\n\n你的回答：${t.a || '（这一轮没有回答完）'}`
      if (block.length > left) { parts.push(`（后面还有 ${turns.length - i} 轮，太长没有列出）`); break }
      parts.push(block); left -= block.length
    }
    return { text: `对话「${clip(s.title, 60)}」（${s.updated_at.slice(0, 16)}，共 ${turns.length} 轮）\n\n${parts.join('\n\n')}`, count: turns.length }
  }
}

export const BUILTIN_TOOLS: ToolDef[] = [updatePlan, askUser, loadPlaybook, sessionState, historySearch, historyRead]
