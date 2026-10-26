/**
 * 内置示例数据：合成的小学英语试卷（题目是编写的演示题，不是任何真实学校的试卷）。
 * 12 份卷子 = 四、五年级 × 3 个学年（2023 / 2024 / 2025）× 期中 + 期末，每份 8–9 道题，带知识点标注、题型、分值、难度、易错标记，
 * 所以加载后总览、分布、同比、重难点都有内容，且 2025 学年相对更早的学年有「新增 / 消失 / 上升 / 下降」可看。
 * 纯数据模块（没有 electron / 数据库依赖），单测直接加载。题目文字写进渲染出来的「原卷页面」里，题目的定位框由渲染得到。
 */
export interface SampleQ {
  qtype: string
  kp: string
  sec?: string[]
  score: number
  diff: number
  err?: string
  stem: string
  options?: string[]
  answer?: string
}

export interface SamplePaper {
  key: string
  grade: '4' | '5'
  semester: '上' | '下'
  year: number
  exam: '期中' | '期末'
  textbook: string
  region: string
  /** 题库里题目的 id（见 POOL），按卷面顺序 */
  qs: string[]
}

const q = (qtype: string, kp: string, score: number, diff: number, stem: string, options: string[] = [], answer = '', err = '', sec: string[] = []): SampleQ => ({ qtype, kp, score, diff, stem, options, answer, err: err || undefined, sec })

export const POOL: Record<string, SampleQ> = {
  phCombo: q('PH_DIFF', 'PH.PHONICS.COMBO', 2, 3, 'Choose the word with a different sound at the underlined part: ship, fish, chair, wish.', ['A. ship', 'B. fish', 'C. chair', 'D. wish'], 'C'),
  phStress: q('PH_DIFF', 'PH.STRESS', 2, 4, 'Which word has a different stress? ', ['A. banana', 'B. potato', 'C. window', 'D. tomato'], 'C', '重音位置容易凭感觉选'),
  classify: q('VO_CLASS', 'VO.FORM.CLASSIFY', 2, 2, 'Which word is different from the others?', ['A. apple', 'B. banana', 'C. pencil', 'D. orange'], 'C'),
  weather: q('MC', 'VO.TOPIC.WEATHER', 2, 1, 'It is ____ today. Take an umbrella with you.', ['A. sunny', 'B. rainy', 'C. windy'], 'B'),
  food: q('MC', 'VO.TOPIC.FOOD', 2, 1, 'I am hungry. I would like some ____.', ['A. noodles', 'B. books', 'C. shoes'], 'A'),
  plReg: q('MC', 'GR.NOUN.PLURAL.REG', 2, 2, 'There are three ____ on the desk.', ['A. book', 'B. books', 'C. bookes'], 'B'),
  plIrr: q('FORM', 'GR.NOUN.PLURAL.IRR', 2, 3, 'Two ____ (child) are playing in the park.', [], 'children', '不规则复数容易写成 childs'),
  possAdj: q('MC', 'GR.PRON.POSS.ADJ', 2, 2, 'This is Amy. ____ bag is red.', ['A. Her', 'B. She', 'C. Hers'], 'A'),
  prepPlace: q('MC', 'GR.PREP.PLACE', 2, 2, 'The cat is ____ the box. I can not see it.', ['A. in', 'B. on', 'C. at'], 'A'),
  third: q('FORM', 'GR.VERB.FORM.THIRD', 2, 3, 'He ____ (watch) TV every evening.', [], 'watches', '以 ch 结尾加 es'),
  presAux: q('MC', 'GR.TENSE.PRES.AUX', 2, 3, 'She does not ____ milk.', ['A. like', 'B. likes', 'C. liking'], 'A', '助动词后动词用原形'),
  presCont: q('MC', 'GR.TENSE.PRES_CONT', 2, 2, 'Look! The boys ____ football on the playground.', ['A. play', 'B. are playing', 'C. played'], 'B'),
  pastReg: q('FORM', 'GR.TENSE.PAST.REG', 2, 3, 'We ____ (clean) the classroom yesterday.', [], 'cleaned', '规则变化加 -ed'),
  pastIrr: q('MC', 'GR.TENSE.PAST.IRREG', 2, 3, 'Mike ____ to Beijing last week.', ['A. goed', 'B. went', 'C. go'], 'B', '不规则动词过去式要背'),
  futGoing: q('FORM', 'GR.TENSE.FUT.GOING', 2, 4, 'I am going to ____ (visit) my grandma this weekend.', [], 'visit', 'be going to 后接动词原形'),
  futWill: q('MC', 'GR.TENSE.FUT.WILL', 2, 3, 'Look at the dark clouds. It ____ rain soon.', ['A. will', 'B. is going to', 'C. was'], 'B'),
  cmpReg: q('MC', 'GR.ADJ.COMPARE.REG', 2, 2, 'My brother is ____ than me.', ['A. tall', 'B. taller', 'C. tallest'], 'B'),
  cmpIrr: q('MC', 'GR.ADJ.COMPARE.IRR', 2, 4, 'This book is ____ than that one.', ['A. good', 'B. better', 'C. best'], 'B', 'good 的比较级不是 gooder'),
  thereBe: q('MC', 'GR.SENT.THEREBE', 2, 2, '____ a pen and two books on the desk.', ['A. There is', 'B. There are', 'C. They are'], 'A', '就近原则'),
  yesNo: q('MC', 'GR.SENT.YESNO.DO', 2, 2, '—____ you like pandas? —Yes, I do.', ['A. Are', 'B. Do', 'C. Does'], 'B'),
  whWhere: q('MC', 'GR.SENT.WH.WHERE', 2, 2, '—____ is my pen? —It is under the bed.', ['A. What', 'B. Where', 'C. Who'], 'B'),
  ordNum: q('MC', 'GR.NUM.ORD', 2, 3, 'Today is the ____ of May.', ['A. five', 'B. fifth', 'C. fiveth'], 'B', '序数词的特殊拼写'),
  modalCan: q('MC', 'GR.VERB.MODAL.CAN', 2, 1, '—Can you swim? —Yes, I ____.', ['A. can', 'B. am', 'C. do'], 'A'),
  shop: q('DIALOG', 'FN.SHOP.PRICE', 3, 3, '—How much is this T-shirt? —____', ['A. It is twenty yuan.', 'B. Yes, it is.', 'C. I like it.'], 'A'),
  dir: q('DIALOG', 'FN.DIR', 3, 3, '—Where is the library? —____', ['A. Go straight and turn left.', 'B. It is a book.', 'C. At seven.'], 'A'),
  suggest: q('DIALOG', 'FN.SUGGEST', 3, 2, '—Let us go to the zoo. —____', ['A. Good idea!', 'B. No, I am not.', 'C. It is nice.'], 'A'),
  order: q('ORDER', 'WR.ORDER', 2, 3, 'Put the words in order: like / I / to / swimming / go / .', [], 'I like to go swimming.'),
  rdFact: q('RD_MC', 'RD.DETAIL.FACT', 3, 2, 'Tom gets up at 6:30 every day. He has breakfast at 7:00. Question: When does Tom have breakfast?', ['A. At 6:30.', 'B. At 7:00.', 'C. At 8:00.'], 'B'),
  rdTf: q('RD_TF', 'RD.DETAIL.TF', 2, 2, 'Amy likes painting. She paints every Sunday. (T/F) Amy paints on Saturdays.', [], 'F'),
  rdInfer: q('RD_MC', 'RD.INFER.REASON', 3, 4, 'Ben was late for school because it rained heavily and the bus did not come. Question: Why was Ben late?', ['A. He got up late.', 'B. The bus did not come.', 'C. He lost his bag.'], 'B', '要从两句话里推出原因'),
  write: q('WRITE', 'WR.EXPR.PAST', 8, 4, 'Write five sentences about what you did last weekend.', [], '', '时态容易混用')
}

const P = (grade: '4' | '5', semester: '上' | '下', year: number, exam: '期中' | '期末', textbook: string, region: string, qs: string[]): SamplePaper =>
  ({ key: `${year}-g${grade}-${exam === '期中' ? 'mid' : 'fin'}`, grade, semester, year, exam, textbook, region, qs })

/** 12 份示例卷。设计要点（四年级）：2023 学年考语音和规则复数；2024 起加比较级、一般过去时；2025 学年新增 be going to 与购物价格，语音字母组合发音不再出现。 */
export const SAMPLE_PAPERS: SamplePaper[] = [
  P('4', '上', 2023, '期中', '人教PEP', '示例市', ['phCombo', 'classify', 'food', 'plReg', 'possAdj', 'prepPlace', 'thereBe', 'rdFact']),
  P('4', '下', 2023, '期末', '人教PEP', '示例市', ['phCombo', 'weather', 'plReg', 'plIrr', 'prepPlace', 'presCont', 'dir', 'rdFact', 'rdTf']),
  P('4', '上', 2024, '期中', '人教PEP', '示例市', ['classify', 'weather', 'plReg', 'cmpReg', 'thereBe', 'yesNo', 'shop', 'rdFact']),
  P('4', '下', 2024, '期末', '人教PEP', '示例市', ['phStress', 'plIrr', 'cmpReg', 'pastReg', 'presCont', 'dir', 'rdFact', 'rdTf', 'order']),
  P('4', '上', 2025, '期中', '外研版', '示例市', ['weather', 'cmpReg', 'cmpIrr', 'pastReg', 'pastIrr', 'shop', 'rdFact', 'rdInfer']),
  P('4', '下', 2025, '期末', '外研版', '示例市', ['phStress', 'plIrr', 'cmpIrr', 'pastIrr', 'futGoing', 'shop', 'suggest', 'rdFact', 'rdInfer']),
  P('5', '上', 2023, '期中', '人教PEP', '示例市', ['classify', 'third', 'presAux', 'presCont', 'ordNum', 'whWhere', 'rdFact', 'rdTf']),
  P('5', '下', 2023, '期末', '人教PEP', '示例市', ['phStress', 'third', 'presAux', 'cmpReg', 'modalCan', 'dir', 'rdFact', 'rdInfer', 'write']),
  P('5', '上', 2024, '期中', '人教PEP', '示例市', ['weather', 'third', 'presAux', 'pastReg', 'ordNum', 'yesNo', 'rdFact', 'rdTf']),
  P('5', '下', 2024, '期末', '人教PEP', '示例市', ['phCombo', 'third', 'pastReg', 'pastIrr', 'cmpIrr', 'suggest', 'rdFact', 'rdInfer', 'write']),
  P('5', '上', 2025, '期中', '外研版', '示例市', ['classify', 'presAux', 'pastIrr', 'futWill', 'whWhere', 'shop', 'rdFact', 'rdTf']),
  P('5', '下', 2025, '期末', '外研版', '示例市', ['phStress', 'pastReg', 'pastIrr', 'futGoing', 'futWill', 'suggest', 'rdFact', 'rdInfer', 'write'])
]

const GRADE_CN = ['', '一', '二', '三', '四', '五', '六']
export const sampleTitle = (p: SamplePaper): string => `【示例】${p.year}-${p.year + 1}学年${GRADE_CN[Number(p.grade)]}年级${p.semester}学期${p.exam}卷（合成）`

/** 稳定的 UUID：同一个 key 永远得到同一个 id，所以「加载示例数据」重复点也不会重复 */
export function sampleUuid(seed: string, hash: (s: string) => string): string {
  const h = hash(`ewb-sample:${seed}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
