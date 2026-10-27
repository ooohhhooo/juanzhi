/**
 * 同类题标注一致性（B9）：同一大题里、考同一个主知识点、同一种题型的题，难度和「易错」应该按同一把尺子给。
 * 真实结果里连续几道「选出画线部分读音不同」难度和易错标得不一致，老师改了一道，同类的别的题还是旧标法。
 * 这里只做提示（不自动改）：找出和多数不一致的题，界面标「需要核对」。纯函数，单测直接加载。
 */
export interface ConsistencyQuestion { id: string; section: string; qtype: string; kp_main: string | null; difficulty: number; error_prone: boolean }

/** 一组至少这么多题才比较（两道题分不出谁对） */
export const MIN_GROUP = 3

export function consistencyHints(qs: ConsistencyQuestion[]): Record<string, string> {
  const groups = new Map<string, ConsistencyQuestion[]>()
  for (const q of qs) {
    if (!q.kp_main) continue
    const k = `${q.section}\u0000${q.qtype}\u0000${q.kp_main}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(q)
  }
  const hints: Record<string, string> = {}
  for (const g of groups.values()) {
    if (g.length < MIN_GROUP) continue
    // 难度：众数；和众数差 2 级以上的题标出来（差 1 级算正常的细微差别）
    const freq = new Map<number, number>()
    for (const q of g) freq.set(q.difficulty, (freq.get(q.difficulty) ?? 0) + 1)
    const [mode, modeN] = [...freq].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    const diffOdd = modeN * 2 > g.length ? g.filter(q => Math.abs(q.difficulty - mode) >= 2) : []
    // 易错：只有一两道和其余不一样（少数派 ≤ 1/4、且占多数的那边至少 3 道）时才提示
    const errN = g.filter(q => q.error_prone).length
    const maj = errN * 2 >= g.length
    const errOdd = (maj ? g.length - errN : errN) * 4 <= g.length && (maj ? errN : g.length - errN) >= 3
      ? g.filter(q => q.error_prone !== maj) : []
    for (const q of diffOdd) hints[q.id] = `同类题（同一大题里考同一个知识点的 ${g.length} 道）大多数难度是 ${mode} 星，这道是 ${q.difficulty} 星，请核对是不是标得不一致`
    for (const q of errOdd) hints[q.id] = (hints[q.id] ? hints[q.id] + '；' : '') + `同类题里大多数${maj ? '标了易错' : '没标易错'}，这道相反，请核对是不是标得不一致`
  }
  return hints
}
