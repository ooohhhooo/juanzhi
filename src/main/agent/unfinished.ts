/**
 * 「说了要做、却没做」的检测（纯规则，不再调模型，单测直接加载）：
 * 模型最后一段话里在承诺一个动作（「我来帮你生成…」「现在开始查…」「接下来我会…」/ "Let me run…"），
 * 返回命中的那句话；是在向用户提问、让用户选择、只是「可以帮你…」的提议、或带条件的（「如果需要…」）都不算。
 */
const VERBS = '生成|查询|查一下|查看|查找|检索|搜索|统计|分析|整理|导出|发送|发到|制作|做一份|做一张|做个|写|读取|读一下|对比|计算|汇总|开始|调用|运行|执行|处理|创建|出一份|拉取|核对|检查|看一下|看看|归类|导入|画|编制|准备|找出|列出'
const GAP = '[^，,。！!？?；;\\n]{0,8}?'
const ZH_PROMISE = new RegExp(
  '(?:我(?:这就|马上|立刻|立即|现在就?|先|将|会|就|来|再|接着|接下来|下面)' + GAP + '(?:' + VERBS + ')' +
  '|让我' + GAP + '(?:' + VERBS + ')' +
  '|(?:现在|接下来|下面|马上|这就|稍等一下?|稍等)[，,\\s]*(?:我(?:会|来|将|就|先)?)?' + GAP + '(?:' + VERBS + '))')
const EN_PROMISE = /\b(?:let me|i(?:'ll| will)|i am going to|i'm going to|now i(?:'ll| will)|next,? i(?:'ll| will)|i(?:'ll| will) now)\b[^.?!\n]{0,40}?\b(?:generate|create|query|search|check|run|export|send|analy[sz]e|fetch|look|write|build|compile|calculate|prepare|pull|import|read|summari[sz]e)/i
const CONDITIONAL = /^(?:如果|如|若|要是|假如|需要的话|有需要|if\b|should you|when you)/i
const OFFER = /(?:我可以|我能|可以帮你|需要我|要我|要不要|是否|你(?:想|要|希望|看)|请(?:选择|告诉|确认|问)|你选|告诉我|哪(?:一|个|种)|would you like|do you want|shall i|can i|i can\b)/i

function sentences(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if ('。！!？?\n'.includes(ch)) { if (cur.trim()) out.push(cur.trim()); cur = '' }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function findUnfinishedPromise(text: string): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  const ss = sentences(t)
  const last = ss[ss.length - 1] ?? ''
  if (/[？?]["”」』）)]*\s*$/.test(t)) return null    // 最后是在问用户
  const tail = t.slice(-200)
  if (/(?:^|\n)\s*(?:[-*]|\d+[.、)）]|[A-D][.、)）])\s+/.test(tail) && /(选|哪个|哪种|回复|告诉我)/.test(t.slice(-120))) return null   // 列了选项让用户选
  if (/[：:]\s*$/.test(last) && /(选|哪|以下|下面|几个)/.test(last) && !ZH_PROMISE.test(last)) return null
  // 只看结尾两句：真正的答案通常在前面，承诺在最后
  for (const s of ss.slice(-2).reverse()) {
    if (CONDITIONAL.test(s) || OFFER.test(s)) continue
    if (/[？?]\s*$/.test(s)) continue
    if (ZH_PROMISE.test(s) || EN_PROMISE.test(s)) return s.length > 60 ? s.slice(0, 59) + '…' : s
  }
  return null
}
export const detectUnfinishedPromise = (text: string): boolean => findUnfinishedPromise(text) !== null

export const nudgeText = (sentence: string): string =>
  `你刚才说「${sentence}」，但这一轮没有调用任何工具。请现在直接调用工具把它做完；如果确实做不了，就说明原因，并告诉用户这件事该切到哪个身份来做。`
