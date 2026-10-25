// M3 E2E 夹具：直接往数据库造「多年级、多学年（2023/2024/2025 三个学年）」的卷子和题目。
// 数据是手工设计的（见 SPEC），测试里的期望值要么写死成手算结果，要么用 naive.cjs 里「逐条循环」的独立算法重算，
// 不拿应用里的 SQL 聚合再算一遍。
//
// 设计要点（grade=4 的子集，目标 2025 学年 5 份、基线 2023+2024 共 6 份，二级知识点视角）：
//   新增   GR.TENSE.FUT   目标 2/5，基线 0/6
//   消失   PH.PHONICS     目标 0/5，基线 3/6
//   上升   GR.TENSE.PAST  基线 3/6=50% → 目标 4/5=80%，+30.0
//          FN.SHOP        基线 1/6=16.7% → 目标 3/5=60%，+43.3（C4 的第 4 题把它标成**次知识点**——次知识点也计出现率）
//   下降   GR.NOUN.PLURAL 基线 6/6=100% → 目标 1/5=20%，−80.0
//   不变   GR.ADJ.COMPARE 3/6 → 3/5（+10），RD.DETAIL 6/6 → 5/5
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

let n = 0
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

// 题目简写：[知识点(主), 题型, 分值, 难度, 易错原因, 次知识点[], 题干]
const Q = (kp, qtype, score, diff, reason = '', sec = [], stem) => ({ kp, qtype, score, diff, reason, sec, stem })

// 论文简写
const P = (key, grade, semester, year, exam, textbook, region, status, qs, extra = {}) => ({
  key, grade, semester, year, exam, textbook, region, status, q: qs, title: `${year}学年${['', '一', '二', '三', '四', '五', '六'][grade]}年级${semester}${exam}卷${key}`, ...extra
})

const SPEC = [
  // ── 2023 学年，四年级，人教PEP（基线）──
  P('A1', '4', '下', 2023, '期末', '人教PEP', '北京', 'done', [
    Q('PH.PHONICS.COMBO', 'PH_DIFF', 2, 3), Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('GR.TENSE.PAST.REG', 'FORM', 2, 3, '规则变化加-ed'),
    // 次知识点与本卷第 2 题的主知识点是同一个节点：同一份卷子里有两道题落在 GR.NOUN.PLURAL.REG 下（题数 +1，出现份数不变，分值不重复计）
    Q('RD.DETAIL.FACT', 'RD_MC', 3, 2, '', ['GR.NOUN.PLURAL.REG'])]),
  P('A2', '4', '下', 2023, '期末', '人教PEP', '北京', 'done', [
    Q('PH.PHONICS.COMBO', 'PH_DIFF', 2, 3), Q('GR.NOUN.PLURAL.IRR', 'FORM', 2, 3), Q('GR.TENSE.PAST.IRREG', 'MC', 2, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('A3', '4', '上', 2023, '期中', '人教PEP', '北京', 'done', [
    Q('PH.PHONICS.COMBO', 'PH_DIFF', 2, 2), Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('FN.SHOP', 'DIALOG', 3, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  // ── 2024 学年，四年级，人教PEP（基线）──
  P('B1', '4', '下', 2024, '期末', '人教PEP', '北京', 'done', [
    Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('GR.TENSE.PAST.REG', 'FORM', 2, 3), Q('GR.ADJ.COMPARE.REG', 'MC', 2, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('B2', '4', '下', 2024, '期末', '人教PEP', '上海', 'done', [
    Q('GR.NOUN.PLURAL.IRR', 'FORM', 2, 3, 'sheep 单复数同形'), Q('GR.ADJ.COMPARE.REG', 'MC', 2, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2), Q('VO.TOPIC.WEATHER', 'MC', null, 1)]),
  P('B3', '4', '上', 2024, '期中', '人教PEP', '上海', 'done', [
    Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('GR.ADJ.COMPARE.IRR', 'MC', 2, 4), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2), Q('VO.TOPIC.WEATHER', 'MC', 2, 1)]),
  // ── 2025 学年，四年级（目标）：C1–C3 人教PEP，C4–C5 外研版 ──
  P('C1', '4', '下', 2025, '期末', '人教PEP', '北京', 'done', [
    Q('GR.TENSE.PAST.REG', 'FORM', 2, 3, '规则变化加-ed'), Q('GR.NOUN.PLURAL.IRR', 'FORM', 2, 3), Q('FN.SHOP.PRICE', 'DIALOG', 3, 3),
    Q('RD.DETAIL.FACT', 'RD_MC', 3, 2, '', ['GR.TENSE.PAST.REG'])]),   // 次知识点 = 一般过去时：一般过去时的题数 +1（它自己的 7 道主知识点题不变），分值不变
  // C2 的第 1 题 = 新增知识点 GR.TENSE.FUT.GOING，带页面框（测试里按 OCR 结果填 bbox），易错
  P('C2', '4', '下', 2025, '期末', '人教PEP', '北京', 'done', [
    Q('GR.TENSE.FUT.GOING', 'MC', 2, 4, 'be going to 后接动词原形', [], '3. A. skirt B. dress C. cold'), Q('GR.TENSE.PAST.IRREG', 'MC', 2, 3), Q('GR.ADJ.COMPARE.REG', 'MC', 2, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)], { pages: true }),
  P('C3', '4', '下', 2025, '期末', '人教PEP', '上海', 'done', [
    Q('GR.TENSE.PAST.REG', 'FORM', 2, 3), Q('FN.SHOP', 'DIALOG', null, 3), Q('GR.ADJ.COMPARE.REG', 'MC', 2, 3), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('C4', '4', '下', 2025, '期末', '外研版', '上海', 'done', [
    Q('GR.TENSE.PAST.IRREG', 'MC', 2, 3), Q('GR.ADJ.COMPARE.REG', 'MC', 2, 3), Q('VO.TOPIC.WEATHER', 'MC', 2, 1),
    Q('RD.DETAIL.FACT', 'RD_MC', 3, 2, '', ['FN.SHOP'])]),   // 次知识点 = 购物：它让购物在 C4 里「出现」（出现率 2/5 → 3/5），但这 3 分不算进购物的分值
  // C5 的第 1 题 = 新增知识点 GR.TENSE.FUT.GOING，有页码但没有定位框（显示整页缩略图）
  P('C5', '4', '上', 2025, '期中', '外研版', '上海', 'done', [
    Q('GR.TENSE.FUT.GOING', 'FORM', 2, 4), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2), Q('VO.TOPIC.WEATHER', 'MC', 2, 1), Q('RD.DETAIL.TF', 'RD_TF', 2, 2)], { pages: true }),
  // ── 五年级：2024 两份、2025 一份（样本有限）──
  P('G1', '5', '下', 2024, '期末', '人教PEP', '北京', 'done', [Q('GR.TENSE.PRES.THIRD', 'FORM', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('G2', '5', '下', 2024, '期末', '人教PEP', '北京', 'done', [Q('GR.TENSE.PRES.THIRD', 'FORM', 2, 2), Q('RD.INFER.REASON', 'RD_MC', 3, 4)]),
  P('G3', '5', '下', 2025, '期末', '人教PEP', '北京', 'done', [Q('GR.TENSE.PRES.THIRD', 'FORM', 2, 2), Q('GR.TENSE.FUT.WILL', 'MC', 2, 3)]),
  // 2024 学年上学期的一份：目标学年（2025）五年级只有下学期的 G3，按学期对齐时它不参与比较
  P('G4', '5', '上', 2024, '期中', '人教PEP', '北京', 'done', [Q('GR.TENSE.PRES.THIRD', 'FORM', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  // ── 六年级：一份 + 一份内容重复导入的副本（测「排除重复导入」）──
  P('H1', '6', '下', 2025, '期末', '外研版', '广州', 'done', [Q('GR.ADJ.COMPARE.IRR', 'MC', 2, 3), Q('VO.TOPIC.WEATHER', 'MC', 2, 1)]),
  P('H1d', '6', '下', 2025, '期末', '外研版', '广州', 'done', [Q('GR.ADJ.COMPARE.IRR', 'MC', 2, 3), Q('VO.TOPIC.WEATHER', 'MC', 2, 1)], { dupOf: 'H1' }),
  // ── 二年级：重复导入的几种状态（同一个文件导入了多份：file_hash 相同）──
  //   K1 原件待审核、K1d 是它的副本且已确认 → 默认（只统计已确认）K1d 顶上，算 1 份；打开「含待审核」后仍是已确认的 K1d 作代表（不会被未确认的原件 K1 顶掉），还是 1 份；此时 K1 算「待审核但未重复计入」
  //   K2d 的原件已被删除（duplicate_of 指向不存在的 id）→ 它是唯一的一份，算 1 份
  P('K1', '2', '上', 2022, '期中', '人教PEP', '北京', 'reviewing', [Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('K1d', '2', '上', 2022, '期中', '人教PEP', '北京', 'done', [Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)], { dupOf: 'K1' }),
  P('K2d', '2', '上', 2022, '期中', '外研版', '广州', 'done', [Q('GR.NOUN.PLURAL.REG', 'MC', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)], { dupOf: '__missing__' }),
  // ── 不计入统计的：待审核（含一个只在它那里出现的知识点）、失败、刚导入的 ──
  P('R1', '4', '下', 2025, '期末', '人教PEP', '北京', 'reviewing', [Q('GR.SENT.YESNO.BE', 'MC', 2, 2), Q('RD.DETAIL.FACT', 'RD_MC', 3, 2)]),
  P('F1', '4', '下', 2025, '期末', '人教PEP', '北京', 'failed', [], { error: 'AI 解析失败（夹具）', error_stage: 'parse' }),
  P('I1', '4', '下', 2025, '期末', '人教PEP', '北京', 'imported', [])
]

const KIND_COUNT_NOTE = '见文件头部注释'

/**
 * 往已初始化（v6）的数据库里写夹具。应用必须是关闭状态。
 * @param bboxes { C2Q1: [x,y,w,h] } 由测试按 OCR 结果算出的定位框
 * @param pageImage 页面图（g4-2025-page1.png）；pageSize { width, height }
 */
function seed(userDataDir, { bboxes, pageImage, pageSize }) {
  const dataDir = path.join(userDataDir, 'workbench-data')
  const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  const ids = {}
  const qids = {}
  const insP = db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, file_name, file_hash, status, error, error_stage, page_count, duplicate_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insQ = db.prepare(`INSERT INTO questions (id, paper_id, ord, no_label, no, section, qtype, stem, options, score, difficulty, error_prone, error_reason, page_idx, bbox_json, bbox_source, confidence, reviewed, flags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 1, 1, '[]')`)
  const insK = db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
  const insPg = db.prepare(`INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text) VALUES (?, 1, 'page-1.png', ?, ?, 'ocr', '[]', '')`)
  db.exec('BEGIN')
  SPEC.forEach((p, i) => {
    ids[p.key] = uid()
    // 创建时间按顺序递增，「最近导入」的顺序是确定的
    const created = `2026-10-${String(10 + Math.floor(i / 10)).padStart(2, '0')} 09:${String(10 + (i % 10)).padStart(2, '0')}:00`
    // 副本与原件是同一个文件：file_hash 相同；原件不存在（__missing__）的副本自己独占一个哈希，duplicate_of 指向一个不存在的 id
    const orphan = p.dupOf === '__missing__'
    insP.run(ids[p.key], p.title, p.grade, p.semester, p.year, p.exam, p.textbook, p.region, `${p.key}.pdf`, `hash-${p.dupOf && !orphan ? p.dupOf : p.key}`, p.status, p.error ?? null, p.error_stage ?? null,
      p.pages ? 1 : 0, p.dupOf ? (orphan ? '99999999-9999-4999-8999-999999999999' : ids[p.dupOf]) : null, created)
    p.q.forEach((q, j) => {
      const id = uid()
      qids[`${p.key}Q${j + 1}`] = id
      const bbox = bboxes[`${p.key}Q${j + 1}`] ?? null
      insQ.run(id, ids[p.key], j + 1, String(j + 1), j + 1, '一', q.qtype, q.stem ?? `${p.key}-${j + 1} 题干`, q.score, q.diff, q.reason ? 1 : 0, q.reason, p.pages ? 1 : null,
        bbox ? JSON.stringify(bbox) : null, bbox ? 'manual' : 'none')
      insK.run(id, q.kp, 1)
      for (const s of q.sec) insK.run(id, s, 0)
    })
    if (p.pages) {
      insPg.run(ids[p.key], pageSize.width, pageSize.height)
      const dir = path.join(dataDir, 'files', ids[p.key])
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(pageImage, path.join(dir, 'page-1.png'))
    }
  })
  db.exec('COMMIT')
  db.close()
  return { ids, qids }
}

module.exports = { SPEC, seed, KIND_COUNT_NOTE }
