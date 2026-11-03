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

export const BUILTIN_TOOLS: ToolDef[] = [updatePlan, askUser, loadPlaybook, sessionState]
