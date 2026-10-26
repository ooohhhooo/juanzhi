/**
 * 加载 / 清除示例数据。纯函数模块（数据库、文件目录、页面渲染都由调用方传入），单测直接加载。
 * 示例卷在 papers 里带 is_sample = 1：
 *   · 统计默认只看真实数据（stats/filter.ts），示例数据要切到「示例数据」才看得到，所以绝不会混进真实数据的统计；
 *   · 导出数据包时不带示例数据；
 *   · 清除示例数据按 is_sample 删（连带页面图、基于示例筛选生成的 AI 报告和同比分析缓存）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { POOL, SAMPLE_PAPERS, sampleTitle, sampleUuid } from './data.ts'
import type { SamplePaper } from './data.ts'

export interface RenderedSamplePage { png: Buffer; width: number; height: number; text: string }
export interface RenderedSamplePaper {
  pages: RenderedSamplePage[]
  /** 每道题：在第几页（1 起）、定位框（归一化 [x, y, w, h]） */
  boxes: Array<{ page: number; bbox: [number, number, number, number] }>
}
export interface SampleRenderInput { key: string; title: string; header: string; questions: Array<{ no: string; lines: string[] }> }
export type SampleRenderer = (papers: SampleRenderInput[]) => Promise<RenderedSamplePaper[]>

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
export const sampleId = (key: string): string => sampleUuid(key, sha1)
export const sampleQuestionId = (key: string, i: number): string => sampleUuid(`${key}#${i + 1}`, sha1)

export function sampleStatus(db: any): { loaded: boolean; papers: number; questions: number } {
  const papers = (db.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1').get() as any).c as number
  const questions = (db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id IN (SELECT id FROM papers WHERE is_sample = 1)').get() as any).c as number
  return { loaded: papers > 0, papers, questions }
}

function renderInput(p: SamplePaper): SampleRenderInput {
  return {
    key: p.key, title: sampleTitle(p),
    header: `${p.year}-${p.year + 1}学年  ${p.grade}年级英语  ${p.exam}  满分 ${p.qs.reduce((n, id) => n + POOL[id].score, 0)} 分    （合成的示例卷）`,
    questions: p.qs.map((id, i) => {
      const x = POOL[id]
      return { no: String(i + 1), lines: [x.stem, ...(x.options?.length ? [x.options.join('     ')] : [])] }
    })
  }
}

export async function loadSample(db: any, filesDir: string, render: SampleRenderer, now: Date = new Date()): Promise<{ papers: number; questions: number; alreadyLoaded: boolean }> {
  const st = sampleStatus(db)
  if (st.loaded) return { papers: st.papers, questions: st.questions, alreadyLoaded: true }
  const rendered = await render(SAMPLE_PAPERS.map(renderInput))
  if (rendered.length !== SAMPLE_PAPERS.length) throw new Error('示例卷的页面渲染结果数量不对')

  // 先写文件（新目录，id 是固定的），再写库；库写失败就把写出的目录删掉
  const written: string[] = []
  try {
    SAMPLE_PAPERS.forEach((p, pi) => {
      const dir = path.join(filesDir, sampleId(p.key))
      fs.mkdirSync(dir, { recursive: true })
      written.push(dir)
      rendered[pi].pages.forEach((pg, k) => fs.writeFileSync(path.join(dir, `page-${k + 1}.png`), pg.png))
    })
    const insP = db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, school, total_score, file_name, file_hash, status, page_count, ai_model, extracted_at, parsed_at, is_sample, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '示例学校', ?, ?, ?, 'done', ?, '示例数据', ?, ?, 1, ?)`)
    const insQ = db.prepare(`INSERT INTO questions (id, paper_id, ord, no_label, no, section, section_title, qtype, stem, options, answer, score, difficulty, error_prone, error_reason, page_idx, bbox_json, bbox_source, confidence, reviewed, flags_json)
      VALUES (?, ?, ?, ?, ?, '一', '示例题', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, 1, '[]')`)
    const insK = db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
    const insPg = db.prepare(`INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text) VALUES (?, ?, ?, ?, ?, 'pdf-text', '[]', ?)`)
    const known = new Set((db.prepare('SELECT code FROM kps').all() as any[]).map(r => r.code))
    let nq = 0
    db.exec('BEGIN')
    try {
      SAMPLE_PAPERS.forEach((p, pi) => {
        const id = sampleId(p.key)
        const r = rendered[pi]
        const created = new Date(now.getTime() - (SAMPLE_PAPERS.length - pi) * 1000)
        const ts = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}:${String(created.getSeconds()).padStart(2, '0')}`
        const total = p.qs.reduce((n, qid) => n + POOL[qid].score, 0)
        insP.run(id, sampleTitle(p), p.grade, p.semester, p.year, p.exam, p.textbook, p.region, total, `示例-${p.key}.pdf`, `sample-${p.key}`, r.pages.length, ts, ts, ts)
        r.pages.forEach((pg, k) => insPg.run(id, k + 1, `page-${k + 1}.png`, pg.width, pg.height, pg.text))
        p.qs.forEach((qid, i) => {
          const x = POOL[qid]
          const box = r.boxes[i]
          const qId = sampleQuestionId(p.key, i)
          insQ.run(qId, id, i + 1, String(i + 1), i + 1, x.qtype, x.stem, JSON.stringify(x.options ?? []), x.answer ?? '', x.score, x.diff, x.err ? 1 : 0, x.err ?? '', box?.page ?? 1, box ? JSON.stringify(box.bbox) : null)
          if (!known.has(x.kp)) throw new Error(`示例题用了树里不存在的知识点：${x.kp}`)
          insK.run(qId, x.kp, 1)
          for (const s of x.sec ?? []) insK.run(qId, s, 0)
          nq++
        })
      })
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { papers: SAMPLE_PAPERS.length, questions: nq, alreadyLoaded: false }
  } catch (e) {
    for (const d of written) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    throw e
  }
}

/** 清除全部示例数据：示例卷（连带页面、题目、标注）、它们的文件，以及基于示例筛选生成的 AI 报告和同比分析缓存 */
export function clearSample(db: any, filesDir: string): { papers: number; reports: number } {
  const ids = (db.prepare('SELECT id FROM papers WHERE is_sample = 1').all() as any[]).map(r => r.id as string)
  let reports = 0
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM papers WHERE is_sample = 1').run()
    reports = Number(db.prepare(`DELETE FROM reports WHERE filter_json LIKE '%"sample":true%'`).run().changes)
    db.prepare(`DELETE FROM ai_analyses WHERE scope_json LIKE '%"sample":true%'`).run()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  for (const id of ids) { try { fs.rmSync(path.join(filesDir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 忽略 */ } }
  return { papers: ids.length, reports }
}
