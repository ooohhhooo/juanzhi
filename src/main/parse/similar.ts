/**
 * 疑似重复 / 部分重复的卷子（A4）。纯函数 + 一个只依赖数据库句柄的入口，单测直接加载。
 *
 * 为什么：导入时只按文件哈希去重，认不出「同一份卷子的第 1 页」「换了个文件格式再导一次」「拍了照又扫了一遍」。
 * 真实案例：运营导入的图片就是已有 2024-2025 卷的第 1 页，看板因此变成 3 份卷子，同比的基线全被扭曲，软件没有任何提示。
 *
 * 做法：解析完成后，把这份卷子的题目文字规范化（小写、去标点和空白、题干和选项合在一起），
 * 和每一份已有卷子成对比「包含度」：A 里有多大比例的题，在 B 里也有。
 *   · 包含度 ≥ 0.8：疑似重复（不管学年年级对不对得上，卷头信息读不出来时也只靠这一条）；
 *   · 包含度 ≥ 0.5，且年级和学年都对得上：疑似重复；
 *   · 包含度 ≥ 0.3，且标题（去掉空白标点后）完全一样：疑似重复；
 *   · 至少 3 道有效题才比（题太少说明不了什么）。
 * 判断是对称的：两份里「被对方包含得更多」的那份（残缺的、只是其中一部分的）被标成 suspect，完整的那份计入统计：
 *   · 先导入整卷、后导入它的第 1 页：标的是新导入的第 1 页；
 *   · 先导入第 1 页、后导入整卷：标的是旧的第 1 页（它的状态会变，因为现在知道有更完整的一份了），整卷计入；
 *   · 两份包含度一样（完全重复）：标后导入的那份。
 * 被标记的卷子默认不计入统计（similar_state = 'suspect'），老师可以选「确实是新卷，计入统计」（accepted，以后不再标）或「删除这份」。
 * 老师确认过（accepted）的卷子永远不会被改状态。库里已有的卷子由 scanSimilar 在升级后扫一遍。
 */

export const MIN_QUESTIONS = 3
export const MIN_KEY_CHARS = 8
export const T_ANY = 0.8
export const T_SAME_META = 0.5
export const T_SAME_TITLE = 0.3

/** 一道题的比对键：题干 + 选项规范化后合在一起（OCR 把选项放进题干还是放进选项，不影响比对）；太短（< 8 个字符）的不当依据 */
export function questionKey(stem: string | null | undefined, options: string[] | string | null | undefined): string | null {
  let opts: string[] = []
  if (Array.isArray(options)) opts = options
  else if (typeof options === 'string' && options) { try { const j = JSON.parse(options); if (Array.isArray(j)) opts = j.map(String) } catch { opts = [options] } }
  const raw = `${stem ?? ''} ${opts.join(' ')}`
  const key = raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/^\d+(?=\p{L})/u, '')
  return key.length >= MIN_KEY_CHARS ? key : null
}

export interface SimPaper {
  id: string
  title: string
  grade: string | null
  school_year_start: number | null
  keys: Set<string>
  /** 导入先后（created_at + rowid，字符串比较）：包含度一样时标后导入的那份 */
  seq?: string
}

const normTitle = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export interface SimilarHit { of: SimPaper; /** 新卷里有多大比例的题在那份旧卷里也有 */ ratio: number; /** 旧卷里有多大比例的题在新卷里也有 */ reverse: number; sameMeta: boolean; sameTitle: boolean }

/** a 被 b 包含到什么程度、算不算疑似（a 是被包含的那份）；达不到判定线返回 null */
export function pairHit(a: SimPaper, b: SimPaper): SimilarHit | null {
  if (a.keys.size < MIN_QUESTIONS || a.id === b.id || b.keys.size === 0) return null
  let inter = 0
  for (const k of a.keys) if (b.keys.has(k)) inter++
  const ratio = inter / a.keys.size
  const reverse = inter / b.keys.size
  const sameMeta = !!a.grade && a.grade === b.grade && a.school_year_start != null && a.school_year_start === b.school_year_start
  const sameTitle = !!normTitle(a.title) && normTitle(a.title) === normTitle(b.title)
  const hit = ratio >= T_ANY || (ratio >= T_SAME_META && sameMeta) || (ratio >= T_SAME_TITLE && sameTitle)
  return hit ? { of: b, ratio, reverse, sameMeta, sameTitle } : null
}

/** 在 others 里找 target 最像是其中一份的一部分的那份（包含度最高、同分取题多的）；target 自己不在 others 里。只看「target 被包含」这一个方向 */
export function findSimilar(target: SimPaper, others: SimPaper[]): SimilarHit | null {
  let best: SimilarHit | null = null
  for (const o of others) {
    const h = pairHit(target, o)
    if (!h) continue
    if (!best || h.ratio > best.ratio || (h.ratio === best.ratio && o.keys.size > best.of.keys.size)) best = h
  }
  return best
}

/**
 * 两份卷子要标哪一份：被对方包含得更多的那份（残缺的）；一样多时标后导入的。都达不到判定线返回 null。
 * flagged = 要标成 suspect 的那份，hit.of = 它像是其中一部分的那份。
 */
export function decideFlag(a: SimPaper, b: SimPaper): { flagged: SimPaper; hit: SimilarHit } | null {
  const ha = pairHit(a, b), hb = pairHit(b, a)
  if (!ha && !hb) return null
  if (ha && !hb) return { flagged: a, hit: ha }
  if (hb && !ha) return { flagged: b, hit: hb }
  const [x, y] = [ha!, hb!]
  if (x.ratio !== y.ratio) return x.ratio > y.ratio ? { flagged: a, hit: x } : { flagged: b, hit: y }
  return (a.seq ?? '') >= (b.seq ?? '') ? { flagged: a, hit: x } : { flagged: b, hit: y }
}

/** 给老师看的白话：像是某份的一部分，还是基本一样 */
export function similarText(title: string, ratio: number, reverse: number): string {
  const pct = Math.round(ratio * 100)
  return reverse >= 0.8 && ratio >= 0.8
    ? `疑似重复：和《${title}》的题目基本一样（${pct}% 的题重合）`
    : `疑似重复：像是《${title}》的一部分（${pct}% 的题在那份卷子里也有）`
}

type Db = any

function loadSim(db: Db, row: { id: string; title: string; grade: string | null; school_year_start: number | null; created_at?: string; rid?: number }): SimPaper {
  const keys = new Set<string>()
  for (const q of db.prepare('SELECT stem, options FROM questions WHERE paper_id = ?').all(row.id) as any[]) {
    const k = questionKey(q.stem, q.options)
    if (k) keys.add(k)
  }
  return { id: row.id, title: row.title || '', grade: row.grade, school_year_start: row.school_year_start, keys, seq: `${row.created_at ?? ''}|${String(row.rid ?? 0).padStart(12, '0')}` }
}

export interface DetectResult {
  /** 这份卷子自己被标成了「像是某份的一部分」时：那份是谁（没有就是 null） */
  self: { of: string; title: string; ratio: number; text: string } | null
  /** 这份卷子比别的卷子更完整，别的（残缺的）卷子被标成 suspect */
  flaggedOthers: Array<{ id: string; title: string; ratio: number }>
}

/**
 * 解析完成后调用：把这份卷子和库里其他卷子成对比，标出被对方包含得更多的那份（见文件头）。
 * 老师已经选过「确实是新卷」（accepted）的不会被标；示例数据不参与。
 * @param opts.olderOnly 只和导入得更早的卷子比（升级后整库扫描时按导入先后依次处理，结果和当时一份份导入一样）
 */
export function detectSimilar(db: Db, paperId: string, opts: { olderOnly?: boolean } = {}): DetectResult | null {
  const me = db.prepare('SELECT id, title, grade, school_year_start, created_at, rowid AS rid, is_sample, similar_state FROM papers WHERE id = ?').get(paperId) as any
  if (!me || me.is_sample === 1) return null
  const target = loadSim(db, me)
  const rows = db.prepare(`SELECT id, title, grade, school_year_start, created_at, rowid AS rid, similar_state FROM papers WHERE id <> ? AND is_sample = 0 AND status IN ('reviewing', 'done')`).all(paperId) as any[]
  let self: SimilarHit | null = null
  const flaggedOthers: DetectResult['flaggedOthers'] = []
  for (const r of rows) {
    const other = loadSim(db, r)
    if (opts.olderOnly && (other.seq ?? '') > (target.seq ?? '')) continue
    const d = decideFlag(target, other)
    if (!d) continue
    if (d.flagged.id === target.id) {
      if (!self || d.hit.ratio > self.ratio || (d.hit.ratio === self.ratio && d.hit.of.keys.size > self.of.keys.size)) self = d.hit
    } else if (r.similar_state !== 'accepted') {
      db.prepare("UPDATE papers SET similar_state = 'suspect', similar_to = ?, similar_ratio = ? WHERE id = ?").run(paperId, Math.round(d.hit.ratio * 1000) / 1000, r.id)
      flaggedOthers.push({ id: r.id, title: r.title || '', ratio: d.hit.ratio })
    }
  }
  if (me.similar_state !== 'accepted') {
    if (self) db.prepare("UPDATE papers SET similar_state = 'suspect', similar_to = ?, similar_ratio = ? WHERE id = ?").run(self.of.id, Math.round(self.ratio * 1000) / 1000, paperId)
    else if (me.similar_state === 'suspect' && !(opts.olderOnly && pointsToNewer(db, paperId, target.seq ?? ''))) db.prepare("UPDATE papers SET similar_state = NULL, similar_to = NULL, similar_ratio = NULL WHERE id = ?").run(paperId)
  }
  const selfOut = self && me.similar_state !== 'accepted' ? { of: self.of.id, title: self.of.title, ratio: self.ratio, text: similarText(self.of.title, self.ratio, self.reverse) } : null
  return selfOut || flaggedOthers.length ? { self: selfOut, flaggedOthers } : null
}

/** 只和更早的比（olderOnly）时：这份卷子的标记是不是因为「后来导入的更完整的那份」打的——是的话这一轮看不到它，不能当成过期标记清掉 */
function pointsToNewer(db: Db, paperId: string, seq: string): boolean {
  const r = db.prepare('SELECT o.created_at c, o.rowid rid FROM papers p JOIN papers o ON o.id = p.similar_to WHERE p.id = ? AND o.is_sample = 0').get(paperId) as any
  return !!r && `${r.c ?? ''}|${String(r.rid ?? 0).padStart(12, '0')}` > seq
}

export interface ScanProgress { done: number; total: number }
export interface ScanResult { checked: number; suspects: number }

/**
 * 整库扫描的核心（生成器：每处理完一份卷子产出一次进度，调用方决定什么时候让出事件循环）。
 * 先把所有卷子的题目键一次性读进内存，两两比对都在内存里做（不再每对卷子都读一遍数据库），最后在一个事务里把变化写回。
 * 语义和「按导入先后一份份 detectSimilar(olderOnly)」完全一样：只和更早导入的比；老师确认过（accepted）的不改；
 * 因更新的完整卷而被标的旧卷，这一轮看不到那份更新的卷，也不会被当成过期标记清掉。
 */
function* scanGen(db: Db): Generator<ScanProgress, ScanResult> {
  const rows = db.prepare(`SELECT id, title, grade, school_year_start, created_at, rowid AS rid, similar_state, similar_to FROM papers
    WHERE is_sample = 0 AND status IN ('reviewing', 'done') ORDER BY created_at, rowid`).all() as any[]
  const keys = new Map<string, Set<string>>()
  for (const q of db.prepare(`SELECT q.paper_id AS pid, q.stem, q.options FROM questions q JOIN papers p ON p.id = q.paper_id
    WHERE p.is_sample = 0 AND p.status IN ('reviewing', 'done')`).all() as any[]) {
    const k = questionKey(q.stem, q.options)
    if (!k) continue
    let set = keys.get(q.pid)
    if (!set) keys.set(q.pid, (set = new Set()))
    set.add(k)
  }
  const sims: SimPaper[] = rows.map(r => ({ id: r.id, title: r.title || '', grade: r.grade, school_year_start: r.school_year_start, keys: keys.get(r.id) ?? new Set<string>(), seq: `${r.created_at ?? ''}|${String(r.rid ?? 0).padStart(12, '0')}` }))
  const bySeq = new Map(sims.map(x => [x.id, x]))
  const init = new Map<string, { state: string | null; to: string | null; ratio: number | null }>(rows.map(r => [r.id, { state: r.similar_state ?? null, to: r.similar_to ?? null, ratio: null }]))
  const cur = new Map(init)
  const rnd = (x: number) => Math.round(x * 1000) / 1000
  for (let i = 0; i < sims.length; i++) {
    const target = sims[i]
    let self: SimilarHit | null = null
    for (let j = 0; j < i; j++) {
      const other = sims[j]
      const d = decideFlag(target, other)
      if (!d) continue
      if (d.flagged.id === target.id) {
        if (!self || d.hit.ratio > self.ratio || (d.hit.ratio === self.ratio && d.hit.of.keys.size > self.of.keys.size)) self = d.hit
      } else if (cur.get(other.id)!.state !== 'accepted') {
        cur.set(other.id, { state: 'suspect', to: target.id, ratio: rnd(d.hit.ratio) })
      }
    }
    const me = cur.get(target.id)!
    if (me.state !== 'accepted') {
      if (self) cur.set(target.id, { state: 'suspect', to: self.of.id, ratio: rnd(self.ratio) })
      else if (me.state === 'suspect') {
        const newer = me.to ? bySeq.get(me.to) : undefined
        if (!(newer && (newer.seq ?? '') > (target.seq ?? ''))) cur.set(target.id, { state: null, to: null, ratio: null })
      }
    }
    yield { done: i + 1, total: sims.length }
  }
  // 只写变了的；一个事务
  const changed = sims.filter(x => { const a = init.get(x.id)!, b = cur.get(x.id)!; return a.state !== b.state || a.to !== b.to || b.ratio !== null })
  if (changed.length) {
    db.exec('BEGIN')
    try {
      const up = db.prepare('UPDATE papers SET similar_state = ?, similar_to = ?, similar_ratio = ? WHERE id = ?')
      // 扫描期间老师可能点了「确实是新卷」、删了卷子、或别的卷子解析完成又检测过：写回前逐份重新读当前状态，
      // 和扫描开始时不一样（或这份卷子已经没了）就不覆盖
      const now = db.prepare('SELECT similar_state AS s, similar_to AS t FROM papers WHERE id = ?')
      for (const x of changed) {
        const a = init.get(x.id)!, b = cur.get(x.id)!
        const c = now.get(x.id) as { s: string | null; t: string | null } | undefined
        if (!c || c.s !== a.state || c.t !== a.to) continue
        up.run(b.state, b.to, b.state ? b.ratio : null, x.id)
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const suspects = (db.prepare("SELECT COUNT(*) c FROM papers WHERE similar_state = 'suspect' AND is_sample = 0").get() as any).c as number
  return { checked: sims.length, suspects }
}

/**
 * 升级后 / 手动「检查重复试卷」：对库里已有的卷子（按导入先后）补跑一遍。同步版（单测、小库用）。
 * 只会把卷子标成 suspect 或清掉过期的标记，不动老师确认过（accepted）的。
 */
export function scanSimilar(db: Db): ScanResult {
  const g = scanGen(db)
  for (;;) { const r = g.next(); if (r.done) return r.value }
}

/**
 * 同一件事的异步版：每处理一小段（约 12 毫秒）就让出一次事件循环，窗口、IPC、别的任务不会被整库扫描卡住。
 * 300 份卷子同步跑约 5.5 秒的主要是数据库往返，现在一次读完，这里只剩内存里的集合比对。
 */
export async function scanSimilarAsync(db: Db, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
  const g = scanGen(db)
  let last = Date.now()
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
    onProgress?.(r.value)
    if (Date.now() - last >= 12) { await new Promise<void>(res => setImmediate(res)); last = Date.now() }
  }
}

/** 删掉一份卷子后：原来因它被标成 suspect 的卷子，要重新判断（它们的「原卷」没了，可能不再是重复） */
export function redetectAfterRemoval(db: Db, removedId: string): void {
  const rows = db.prepare("SELECT id FROM papers WHERE similar_state = 'suspect' AND similar_to = ?").all(removedId) as Array<{ id: string }>
  for (const r of rows) db.prepare("UPDATE papers SET similar_state = NULL, similar_to = NULL, similar_ratio = NULL WHERE id = ?").run(r.id)
  for (const r of rows) detectSimilar(db, r.id)
}
