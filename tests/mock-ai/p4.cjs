// mock 的老师版附加段应答（M9 beta.3）：口诀（p3_tricks）、同类变形题出题（p4_variant_gen）、变形题独立解答（p4_variant_check）。
// 都从收到的 user 提示词里读程序填好的表，输出严格 JSON。独立解答靠一张「题干 → 正确选项文字」的表来「做题」，
// 这样 E2E 可以反过来断言：程序调整过选项顺序后，第二次解答仍然能对上；也能注入「第二次解答与出题答案不一致」。
//
// quirks（mock.quirks = { ... }）：
//   trickPrice      —— 第一条口诀里夹价格 / 营销的说法（程序应整条去掉）
//   trickNone       —— 口诀全部不合格（程序应让这一段失败）
//   variantDisagree —— 第二次解答对第 N 题（从 1 起）给出和出题不同的答案（该题应标「答案有争议」）
//   variantPrice    —— 第 1 题的讲解里带「报名」（程序应整题剔除）
//   variantDup      —— 第 2 题和第 1 题的题干一模一样（程序应剔除第 2 题）
//   variantBadJson  —— 出题输出不是 JSON（这一段应失败）
//   variantRule     —— 第 1 题的讲解里带一句证据里没有的英语规则（应标「未核实」）
const SECTION = (user, head) => {
  const i = user.indexOf(head)
  if (i < 0) return []
  const rows = []
  let started = false
  for (const line of user.slice(i + head.length).split('\n').slice(1)) {
    if (!started) { if (line.startsWith('列：')) started = true; continue }
    if (!line.trim() || line.startsWith('【')) break
    if (line.trim() === '（无）') break
    rows.push(line.split(' | '))
  }
  return rows
}

const correct = new Map()   // 题干 → 正确选项的文字（choice）或答案（blank）

const isTricks = (sys) => /【任务：口诀大招】/.test(sys)
const isVariantGen = (sys) => /【任务：同类变形题】/.test(sys)
const isVariantCheck = (sys) => /【任务：独立解答】/.test(sys)

function buildTricks(user, quirks = {}) {
  const rows = SECTION(user, '【易错点】')
  const tricks = rows.map((r, i) => ({ n: Number(r[0]), trick: `${r[1]}别马虎，先看清题再下笔。` }))
  if (quirks.trickNone) return JSON.stringify({ tricks: tricks.map(t => ({ ...t, trick: '报名立减 50 元，保证提分' })) })
  if (quirks.trickPrice && tricks[0]) tricks[0].trick = '报名立减 50 元，保证提分。'
  return JSON.stringify({ tricks })
}

function buildVariants(user, quirks = {}) {
  if (quirks.variantBadJson) return '这是三道题：第一题……（不是 JSON）'
  const n = Math.max(1, SECTION(user, '【考点】').length)
  const mk = (i, qtype, stem, options, answerText, explanation) => {
    const kp = (i % n) + 1
    if (qtype === 'choice') {
      const letter = 'ABCD'[options.indexOf(answerText)]
      correct.set(stem, answerText)
      return { kp, qtype, stem, options, answer: letter, explanation, changed: '同一个考点换了场景' }
    }
    correct.set(stem, answerText)
    return { kp, qtype, stem, options: [], answer: answerText, explanation, changed: '同一个考点换了场景' }
  }
  const q = [
    mk(0, 'choice', 'Mia has two pens. She says: "These are my ____."', ['pen', 'pens', 'a pen', "pen's"], 'pens', quirks.variantPrice ? '报名后保证你会做这类题。' : quirks.variantRule ? 'be good at 后接动词原形。' : '对照题干里的数量再选。'),
    mk(1, 'choice', 'Ben ____ to school by bike every day.', ['go', 'goes', 'going', 'gone'], 'goes', '看清主语是谁。'),
    mk(2, 'blank', 'Mum is in the kitchen. She ____ (c) dinner every evening.', [], 'cooks', '先想谁在做事，再补单词。')
  ]
  if (quirks.variantDup) q[1] = { ...q[0], kp: q[1].kp }
  return JSON.stringify({ questions: q })
}

function buildCheck(user, quirks = {}) {
  const block = user.split('【题目】')[1] ?? ''
  const qs = block.split(/\n\n+/).map(s => s.trim()).filter(s => /^\d+\./.test(s))
  const answers = qs.map(b => {
    const lines = b.split('\n')
    const i = Number(/^(\d+)\./.exec(lines[0])[1])
    const stem = lines[0].replace(/^\d+\.\s*/, '')
    const opts = lines.slice(1).map(l => /^([A-D])\.\s*(.*)$/.exec(l)).filter(Boolean)
    const want = correct.get(stem)
    if (opts.length) {
      let letter = opts.find(m => m[2] === want)?.[1] ?? 'A'
      if (quirks.variantDisagree === i) letter = 'ABCD'[('ABCD'.indexOf(letter) + 1) % 4]
      return { i, answer: letter, reason: '按题干判断。' }
    }
    return { i, answer: quirks.variantDisagree === i ? 'goes' : (want ?? ''), reason: '按题干判断。' }
  })
  return JSON.stringify({ answers })
}

module.exports = { isTricks, isVariantGen, isVariantCheck, buildTricks, buildVariants, buildCheck }
