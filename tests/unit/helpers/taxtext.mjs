// 单测用：和 src/main/ai/taxonomy.ts 的 loadTaxonomy 同一段逻辑（那个文件依赖 electron 的 getDb，单测里取不到），只取知识点树的文本。
import { flatKpText } from '../../../src/main/pack/kp-rules.ts'
export function loadTaxonomyText(db) {
  const kps = db.prepare('SELECT code, parent_code, name, intro_grade, note, plain FROM kps WHERE deprecated = 0 ORDER BY sort, code').all()
  const by = new Map(kps.map(k => [k.code, k]))
  const path = k => { const n = [flatKpText(k.name)]; let p = k.parent_code ? by.get(k.parent_code) : null; while (p) { n.unshift(flatKpText(p.name)); p = p.parent_code ? by.get(p.parent_code) : null } return n.join('/') }
  return kps.map(k => `${k.code} | ${path(k)} | ${k.intro_grade ?? '-'} | ${flatKpText(k.note ?? '')} | ${flatKpText(k.plain ?? '') || '—'}`).join('\n')
}
