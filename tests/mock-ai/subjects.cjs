// mock 的语文 / 数学 P1 应答：按 system 里的「小学数学 / 小学语文」识别学科，只给第一批第一页几道代码合法的题。
// 代码都取自内置种子（taxonomy-math.ts / taxonomy-chinese.ts）。内容虚构。
const BANK = {
  math: {
    meta: { title: '五年级数学期末测试卷', grade: 5, semester: '上', school_year: '2025-2026', exam_type: '期末', textbook: null, total_score: 100 },
    sections: [{ no: '一', title: '直接写得数', qtype: 'MA_ORAL', score_each: 1, total_score: 8 }, { no: '二', title: '填空', qtype: 'MA_FILL', score_each: 1, total_score: 10 }],
    questions: [
      { no: '~1', section: '一', qtype: 'MA_ORAL', stem: '直接写得数：3/4+1/4=；0.5×8=', kp_main: 'MA.CALC.FRAC.ADDSUB_SAME', kp_secondary: ['MA.CALC.DEC.MUL'], difficulty: 2, score: 8, flags: ['no_number'] },
      { no: '1', section: '二', qtype: 'MA_FILL', stem: '3.5 m² =（ ）dm²', kp_main: 'MA.MEAS.UNIT.AREA', kp_secondary: [], difficulty: 3, score: 1, error_prone: true, error_reason: '1 m² = 100 dm²，别和长度进率 10 混淆' }
    ]
  },
  chinese: {
    meta: { title: '四年级语文期末测试卷', grade: 4, semester: '下', school_year: '2025-2026', exam_type: '期末', textbook: '统编版', total_score: 100 },
    sections: [{ no: '一', title: '看拼音，写词语', qtype: 'CN_PY_WRITE', score_each: 2, total_score: 8 }, { no: '二', title: '选择加点字的正确读音', qtype: 'CN_ZHUYIN', score_each: 2, total_score: 4 }],
    questions: [
      { no: '~1', section: '一', qtype: 'CN_PY_WRITE', stem: '看拼音，写词语：péng you；jì zhù', kp_main: 'CN.CHAR.WRITE.SPELL', kp_secondary: [], difficulty: 1, score: 8, flags: ['no_number'] },
      { no: '1', section: '二', qtype: 'CN_ZHUYIN', stem: '这件行李很重。（zhòng  chóng）', kp_main: 'CN.CHAR.SOUND.POLY', kp_secondary: [], difficulty: 2, score: 2, error_prone: true, error_reason: '‘重’在‘重量’里读 zhòng', flags: ['underline_lost'] }
    ]
  }
}

/** sys 里写着「小学数学 / 小学语文」就是对应学科的 P1 提示词；否则返回 null（走英语的 canned） */
const subjectOf = (sys) => (/小学数学校内考试卷/.test(sys) ? 'math' : /小学语文校内考试卷/.test(sys) ? 'chinese' : null)

function build(subject, { mode, pages, prefix }) {
  const b = BANK[subject]
  const first = pages[0] === 1
  const questions = first ? b.questions.map((q, i) => ({
    material_id: null, options: [], answer: '', kp_suggestion: '', error_prone: !!q.error_prone, error_reason: q.error_reason || '', page: 1,
    continued_from_prev: false, continues_next: false, flags: [], ...q,
    ...(mode === 'vision' ? { anchor: [0.1, 0.1 + i * 0.1, 0.7, 0.03] } : { anchor: q.stem.slice(0, 12), anchor_ref: `1-${String(i + 2).padStart(2, '0')}` })
  })) : []
  return {
    meta: first ? b.meta : { title: null, grade: null, semester: null, school_year: null, exam_type: null, textbook: null, total_score: null },
    sections: first ? b.sections.map(s => ({ ...s, continued_from_prev: false })) : [], materials: [], questions, notes: []
  }
}

module.exports = { subjectOf, build, BANK }
