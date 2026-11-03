/**
 * 分享卡片的 Agent 工具：card_templates（列模板）、card_make（出卡片，存为本会话的图片产出）。
 * 不依赖 electron（渲染在 make.ts 里按需加载）。
 */
import { z } from 'zod'
import type { AgentTool } from '../agent/tool-types.ts'
import { ALL_KINDS, KIND_HELP, PARENT_KINDS, STUDENT_KINDS } from './schema.ts'
import { makeCard, templateRows } from './make.ts'
import { readCardSettings } from './templates.ts'

const PRIVACY = '隐私规则（程序也会检查）：家长卡只能写这一个孩子的信息，不写其他孩子的名字，不写排名或和别的孩子比较；孩子称呼只用名（程序会按设置去掉姓，也可能设置为不写名字）；任何卡片都不能出现手机号（出现就拒绝生成）。'

export const cardTemplates: AgentTool = {
  name: 'card_templates',
  description: `列出分享卡片的模板：编号、名称、适合场景、是否是当前默认。audience=student 是给学生的（动漫风），parent 是给家长的（稍正式）。不指定 templateId 时 card_make 用默认模板，一般不用问老师选哪个。`,
  params: z.object({ audience: z.enum(['student', 'parent']) }),
  level: 'read',
  async run(a, ctx) {
    const rows = templateRows(a.audience, ctx.dataDir)
    return { ok: true, message: rows.map(r => `${r.id}｜${r.name}｜${r.scene}${r.isDefault ? '｜默认' : ''}`).join('\n'), data: { childName: readCardSettings(ctx.dataDir).childName } }
  }
}

export const cardMake: AgentTool = {
  name: 'card_make',
  description: [
    '做一张可以发给学生或家长的分享卡片（竖版图片），存到右侧产出面板，老师预览确认后再复制或发送。一张卡只讲一个点；字要少，超过字数上限的部分会被截断（结果里会提示）。',
    `audience=student 的版式：${STUDENT_KINDS.join(' / ')}；audience=parent 的版式：${PARENT_KINDS.join(' / ')}。content 的字段（≤ 是字数上限）：`,
    ...ALL_KINDS.map(k => '· ' + KIND_HELP[k]),
    'knowledge 的 example.en 里可以用 **词** 标出要强调的词。',
    PRIVACY,
    '内容里写学员代号即可（程序生成图片时换成真名）。内容太多排不下会报错，精简后重试。'
  ].join('\n'),
  params: z.object({
    audience: z.enum(['student', 'parent']),
    kind: z.enum(ALL_KINDS as [string, ...string[]]),
    templateId: z.string().max(20).optional(),
    content: z.record(z.any())
  }),
  level: 'draft',
  async run(a, ctx) {
    const r = await makeCard({ dataDir: ctx.dataDir, sessionId: ctx.sessionId }, { audience: a.audience, kind: a.kind as any, templateId: a.templateId, content: a.content })
    const tip = r.notices.length ? `\n提示：${r.notices.join('；')}。下次写短一点。` : ''
    return { ok: true, message: `卡片已做好，在右侧产出面板「${r.name}」（模板 ${r.templateName}）。请让老师先预览确认，再复制图片或发送。文件：${r.path}${tip}`, data: { outputId: r.outputId, path: r.path, templateId: r.templateId } }
  }
}

export const CARD_TOOLS: AgentTool[] = [cardTemplates, cardMake]
