/**
 * 草稿 → Skill 正文、两版对比（纯函数，不依赖 node 模块，界面也直接用它）。
 */
import type { SkillDraft } from './draft.ts'

/** 草稿 → Skill 正文（Markdown）。工具名用反引号写出来，保存时会核对是否存在 */
export function composeBody(d: Pick<SkillDraft, 'name' | 'when' | 'params' | 'steps' | 'output' | 'checklist'>): string {
  const L: string[] = [`# ${d.name}`, '']
  if (d.when) L.push(`适用：${d.when}`, '')
  if (d.params.length) {
    L.push('## 需要你告诉我', '先看用户的话里有没有下面这些信息；缺的用 ask_user 问一次（给选项），不要自己猜。', '')
    for (const p of d.params) L.push(`- ${p.name}${p.hint ? `：${p.hint}` : ''}`)
    L.push('')
  }
  if (d.steps.length) {
    L.push('## 步骤', '')
    d.steps.forEach((s, i) => {
      const tool = s.tool ? `（用 \`${s.tool}\`）` : ''
      const opt = s.optional ? `（有时需要${s.condition ? `：${s.condition}` : ''}）` : ''
      L.push(`${i + 1}. ${s.text}${tool}${opt}`)
    })
    L.push('')
  }
  if (d.output.trim()) L.push('## 输出格式', '', d.output.trim(), '')
  if (d.checklist.length) { L.push('## 做完检查', ''); for (const c of d.checklist) L.push(`- [ ] ${c}`); L.push('') }
  return L.join('\n').trim() + '\n'
}

export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }
/** 两版正文按行对比（LCS） */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.replace(/\r\n/g, '\n').split('\n'), y = b.replace(/\r\n/g, '\n').split('\n')
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let k = y.length - 1; k >= 0; k--) dp[i][k] = x[i] === y[k] ? dp[i + 1][k + 1] + 1 : Math.max(dp[i + 1][k], dp[i][k + 1])
  const out: DiffLine[] = []
  let i = 0, k = 0
  while (i < x.length && k < y.length) {
    if (x[i] === y[k]) { out.push({ type: 'same', text: x[i] }); i++; k++ }
    else if (dp[i + 1][k] >= dp[i][k + 1]) out.push({ type: 'del', text: x[i++] })
    else out.push({ type: 'add', text: y[k++] })
  }
  while (i < x.length) out.push({ type: 'del', text: x[i++] })
  while (k < y.length) out.push({ type: 'add', text: y[k++] })
  return out
}

/** 保存时的「只根据 N 次对话」标注 */
export const thinNote = (n: number): string => (n < 3 ? `只根据 ${n} 次对话，可能不够通用` : '')
