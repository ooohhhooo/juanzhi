/**
 * 学科注册表：英语 / 语文 / 数学。所有「按学科不同」的常量都放这里，别处只引用、不再写死。
 * 纯数据 + 纯函数，不依赖 electron，主进程、界面、单测都直接加载（不要用 enum / namespace）。
 *
 * 约定：
 *  - 数据库 papers / reports / course_outlines / agent_sessions / kps / qtypes 的 subject 列只取这里的 id；旧数据默认 'english'。
 *  - 知识点代码、题型代码全局唯一：英语沿用 v1 的代码（PH / VO / GR / FN / LS / RD / WR，题型 MC / FILL / OTHER…），
 *    语文用 CN. / CN_ 前缀，数学用 MA. / MA_ 前缀。
 *  - 统计筛选里 subject 缺省 = 英语（老版本存下的筛选条件、报告和缓存键都不带 subject，升级后仍然有效）。
 */

export const SUBJECT_IDS = ['english', 'chinese', 'math'] as const
export type SubjectId = typeof SUBJECT_IDS[number]
export const DEFAULT_SUBJECT: SubjectId = 'english'

/** 知识点大类：界面按 slot（1–6）着色，颜色旁边永远写 label */
export interface SubjectCategory {
  key: string
  label: string
  gloss: string
  /** 一级知识点代码 */
  codes: string[]
  slot: 1 | 2 | 3 | 4 | 5 | 6
}

export interface SubjectDef {
  id: SubjectId
  /** 中文名：英语 / 语文 / 数学 */
  name: string
  /** 侧栏徽标上的单字 */
  short: string
  /** 知识点一级代码（code-guard 识别内部代码、按代码判断学科都用它） */
  kpRoots: string[]
  /** 题型代码前缀（英语为空：v1 题型没有前缀） */
  qtypePrefix: string
  /** 本学科的「其他」题型 */
  otherQtype: string
  /** 题型分组（qtypes.group → 显示名）；顺序即审核页下拉里的分组顺序 */
  qtypeGroups: Array<{ id: string; label: string }>
  /** 知识点例子字段（kps.example_en / example_zh）在界面上的叫法；英语是「英文例句 / 中文意思」，其余学科只用 example_zh */
  exampleLabels: { en: string | null; zh: string }
  categories: SubjectCategory[]
  /** 导入时可选的教材版本 */
  textbooks: string[]
  /** 默认读图策略：数学卷子的分数、竖式、图形靠文字识别认不准，默认交给能看图的模型 */
  visionDefault: 'auto' | 'images_always'
}

export const SUBJECTS: Record<SubjectId, SubjectDef> = {
  english: {
    id: 'english', name: '英语', short: '英',
    kpRoots: ['PH', 'VO', 'GR', 'FN', 'LS', 'RD', 'WR', 'MC'],
    qtypePrefix: '', otherQtype: 'OTHER',
    qtypeGroups: [{ id: 'listening', label: '听力题型' }, { id: 'written', label: '笔试题型' }],
    exampleLabels: { en: '英文例句', zh: '中文意思' },
    categories: [
      { key: 'phonics', label: '语音', gloss: '字母、字母组合发音、重音和语调', codes: ['PH'], slot: 1 },
      { key: 'vocab', label: '词汇', gloss: '主题词汇、词形变化、短语搭配', codes: ['VO'], slot: 2 },
      { key: 'grammar', label: '语法', gloss: '名词、代词、时态、介词、句型等', codes: ['GR'], slot: 3 },
      { key: 'communication', label: '交际', gloss: '日常对话与功能用语：问路、购物、打电话', codes: ['FN'], slot: 4 },
      { key: 'reading', label: '阅读', gloss: '阅读理解与听力理解（理解类）', codes: ['RD', 'LS'], slot: 5 },
      { key: 'writing', label: '写作', gloss: '写句子、书面表达', codes: ['WR'], slot: 6 }
    ],
    textbooks: ['人教PEP', '外研版', '北师大版', '译林版', '沪教版', '科普版', '教科版', '川教版', '接力版', '辽师大版', '鲁科版', '北京版', '清华版', '外研剑桥版'],
    visionDefault: 'auto'
  },
  chinese: {
    id: 'chinese', name: '语文', short: '语',
    kpRoots: ['CN'],
    qtypePrefix: 'CN_', otherQtype: 'CN_OTHER',
    qtypeGroups: [{ id: 'basic', label: '积累运用' }, { id: 'read', label: '阅读' }, { id: 'write', label: '表达' }],
    exampleLabels: { en: null, zh: '例子' },
    categories: [
      { key: 'cn-pinyin', label: '拼音识字', gloss: '汉语拼音、识字与写字', codes: ['CN.PY', 'CN.CHAR'], slot: 1 },
      { key: 'cn-word', label: '词语', gloss: '组词、近反义词、搭配、成语', codes: ['CN.WORD'], slot: 2 },
      { key: 'cn-sent', label: '句子', gloss: '句式变换、修辞、标点、病句', codes: ['CN.SENT'], slot: 3 },
      { key: 'cn-accu', label: '古诗文积累', gloss: '古诗词、文言文、课文背诵、名言', codes: ['CN.ACCU'], slot: 4 },
      { key: 'cn-read', label: '阅读', gloss: '课内外阅读理解', codes: ['CN.READ'], slot: 5 },
      { key: 'cn-write', label: '表达', gloss: '口语交际、写话与习作', codes: ['CN.ORAL', 'CN.WRITE'], slot: 6 }
    ],
    textbooks: ['统编版', '统编版（五四制）', '其他'],
    visionDefault: 'auto'
  },
  math: {
    id: 'math', name: '数学', short: '数',
    kpRoots: ['MA'],
    qtypePrefix: 'MA_', otherQtype: 'MA_OTHER',
    qtypeGroups: [{ id: 'calc', label: '计算' }, { id: 'basic', label: '概念与基础' }, { id: 'geo', label: '图形与操作' }, { id: 'apply', label: '解决问题' }],
    exampleLabels: { en: null, zh: '例子' },
    categories: [
      { key: 'ma-num', label: '数的认识', gloss: '整数、小数、分数、百分数、因数倍数', codes: ['MA.NUM'], slot: 1 },
      { key: 'ma-calc', label: '运算', gloss: '口算、笔算、混合运算、运算律、估算', codes: ['MA.CALC'], slot: 2 },
      { key: 'ma-alg', label: '数量关系', gloss: '规律、用字母表示数、方程、比和比例', codes: ['MA.ALG', 'MA.MEAS'], slot: 3 },
      { key: 'ma-geo', label: '图形与几何', gloss: '认识图形、周长面积体积、位置与运动', codes: ['MA.GEO'], slot: 4 },
      { key: 'ma-stat', label: '统计与概率', gloss: '统计表、统计图、平均数、可能性', codes: ['MA.STAT'], slot: 5 },
      { key: 'ma-prob', label: '解决问题', gloss: '应用题、数学思考与综合实践', codes: ['MA.PROB', 'MA.THINK'], slot: 6 }
    ],
    textbooks: ['人教版', '北师大版', '苏教版', '青岛版（六三制）', '青岛版（五四制）', '冀教版', '西师版', '北京版', '沪教版', '其他'],
    visionDefault: 'images_always'
  }
}

export const SUBJECT_LIST: SubjectDef[] = SUBJECT_IDS.map(id => SUBJECTS[id])

export const isSubjectId = (v: unknown): v is SubjectId => typeof v === 'string' && (SUBJECT_IDS as readonly string[]).includes(v)

/** 不认识的值（旧数据、损坏的设置）一律当英语 */
export const asSubject = (v: unknown): SubjectId => (isSubjectId(v) ? v : DEFAULT_SUBJECT)

export const subjectName = (v: unknown): string => SUBJECTS[asSubject(v)].name

/** 所有学科知识点一级代码（去重），给 code-guard 用 */
export const ALL_KP_ROOTS: string[] = [...new Set(SUBJECT_LIST.flatMap(s => s.kpRoots))]

/** 知识点或题型代码属于哪个学科；认不出返回 null */
export function subjectOfCode(code: string | null | undefined): SubjectId | null {
  if (!code) return null
  const c = code.trim()
  for (const s of SUBJECT_LIST) {
    if (s.qtypePrefix && c.startsWith(s.qtypePrefix)) return s.id
    if (s.kpRoots.some(r => c === r || c.startsWith(r + '.'))) return s.id
  }
  return null
}

/** 知识点代码属于本学科的哪个大类（按最长前缀匹配）；认不出返回 null */
export function categoryOf(subject: SubjectId, code: string | null | undefined): SubjectCategory | null {
  if (!code) return null
  let best: SubjectCategory | null = null
  let bestLen = -1
  for (const cat of SUBJECTS[subject].categories) {
    for (const p of cat.codes) {
      if ((code === p || code.startsWith(p + '.')) && p.length > bestLen) { best = cat; bestLen = p.length }
    }
  }
  return best
}

/** 课程大纲四个「内容列」在各学科的叫法（存库的类型名不变：phonics / word / pattern / expression） */
export const COURSE_FIELD_LABELS: Record<SubjectId, { phonics: string; word: string; pattern: string; expression: string }> = {
  english: { phonics: '字母与语音', word: '词汇', pattern: '句型', expression: '实用表达' },
  math: { phonics: '计算与口算', word: '知识点', pattern: '例题', expression: '方法' },
  chinese: { phonics: '识字与写字', word: '词语积累', pattern: '阅读', expression: '写作与表达' }
}

/** 自建知识点在根上的代码前缀（避免三个学科的 U.U1 互相撞）：英语沿用 U，其余 CN.U / MA.U */
export const customRootPrefix = (s: SubjectId): string => (s === 'english' ? 'U' : `${SUBJECTS[s].kpRoots[0]}.U`)
