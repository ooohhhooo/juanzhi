/**
 * 内置知识点树 v1 与题型表（迁移 v5 写入 kps / qtypes）。
 *
 * 依据：《义务教育英语课程标准（2022 年版）》附录 4 的语法项目、主题表，以及人教 PEP（三年级起点）三～六年级的编排。
 * 层级：一级 = 设计方案 §7 表格中的大类（语法拆成 GR.NOUN / GR.TENSE 等独立大类）；二级、三级逐层细化。
 * 代码一经发布就不再改（统计、题目标注都引用它），要改名只改 name，要合并走 merged_into。
 * parent_code / level 由代码前缀推导（见 buildKpRows），不在这里手写，避免两处不一致。
 *
 * 注意：这个文件会被 node --experimental-strip-types 直接加载做单元测试，不要使用 enum / namespace。
 */

/** [代码, 名称, 常见引入年级, 说明或例词] */
export type KpSeed = [code: string, name: string, introGrade: number, note: string]

export const TAXONOMY_VERSION = 1

/** v5 迁移写入的种子，**冻结**：不要再改这份数据（否则新装用户与从 v4 升级的用户会得到不同的树）。
 *  知识点要更新，就新增 KP_SEEDS_V2 并写 v6 迁移（INSERT OR IGNORE / 只更新 builtin=1 且未被用户改过的节点）。 */
export const KP_SEEDS_V1: KpSeed[] = [
  // ───── 语音 PH ─────
  ['PH', '语音', 3, '字母、字母发音、重音与语调'],
  ['PH.LETTER', '字母', 3, '字母名称与顺序、大小写对应与书写、缩略词读法（PE、TV）'],
  ['PH.PHONICS', '字母与字母组合发音', 3, '自然拼读：画线部分读音是否相同'],
  ['PH.PHONICS.VOWEL', '元音字母发音', 3, 'a e i o u 的长短音，如 cake/cat、bike/big'],
  ['PH.PHONICS.CONSONANT', '辅音字母发音', 3, 'c g s x 等多音辅音，如 city/cat、gym/go'],
  ['PH.PHONICS.COMBO', '字母组合发音', 4, 'ar/or/ir/er/ur/ea/ee/ow/ou/oo/th/sh/ch/ph 等'],
  ['PH.PHONICS.MAGIC_E', '开音节与不发音字母', 4, 'a_e / i_e / o_e / u_e，kn-、wr-、-mb 中的不发音字母'],
  ['PH.STRESS', '重音与语调', 5, '单词重音位置；陈述句/特殊疑问句降调，一般疑问句升调'],
  ['PH.SYLLABLE', '音节与拼读', 4, '音节划分、按音节拼读、押韵'],

  // ───── 词汇 VO ─────
  ['VO', '词汇', 3, '主题词汇、词形变化、短语搭配'],
  ['VO.TOPIC', '主题词汇', 3, '按课标主题分类的核心词汇'],
  ['VO.TOPIC.SCHOOL', '学校生活', 3, '学科、场所（library, art room）、文具、教室物品'],
  ['VO.TOPIC.FAMILY', '家庭与人物', 3, '家庭成员、朋友、职业（doctor, farmer）'],
  ['VO.TOPIC.FOOD', '食物与饮料', 3, '蔬菜水果、餐点、味道（carrot, tomato, noodles）'],
  ['VO.TOPIC.CLOTHES', '服装与购物', 4, '衣物（skirt, dress, pants）、尺码、颜色'],
  ['VO.TOPIC.WEATHER', '天气与季节', 4, 'sunny, windy, cloudy, rainy, snowy；四季'],
  ['VO.TOPIC.ANIMAL', '动物与自然', 3, '动物、农场（hen, sheep, farm）、植物、自然环境'],
  ['VO.TOPIC.BODY', '身体与健康', 3, '身体部位、感觉（hungry, thirsty）、常见病痛'],
  ['VO.TOPIC.TIME', '时间与节日', 4, '月份、星期、季节、节日、钟点词'],
  ['VO.TOPIC.PLACE', '地点与交通', 4, '城镇场所（hospital, cinema）、方位、交通工具'],
  ['VO.TOPIC.HOBBY', '爱好与活动', 4, '运动、爱好、周末与假期活动（play football, go swimming）'],
  ['VO.FORM', '词汇运用与变形', 3, '词义关系、分类、拼写与缩略'],
  ['VO.FORM.OPPOSITE', '反义词', 4, 'hot–cold, big–small, up–down'],
  ['VO.FORM.SYNONYM', '同义词与近义词', 5, 'big–large，同音词（see–sea, no–know）'],
  ['VO.FORM.CLASSIFY', '词汇分类（选出不同类）', 3, '选出不属于同一类的单词'],
  ['VO.FORM.ABBREV', '缩略形式', 4, "can not→can't, I am→I'm, it is→it's"],
  ['VO.FORM.SPELLING', '单词拼写', 3, '根据中文、图片或首字母写出单词'],
  ['VO.PHRASE', '短语与搭配', 4, '动词短语、固定搭配'],
  ['VO.PHRASE.VERB', '动词短语', 4, 'get up, go to school, have lunch, look at'],
  ['VO.PHRASE.COLLOC', '固定搭配', 5, 'a pair of, a cup of, how about, be good at'],

  // ───── 名词 GR.NOUN ─────
  ['GR.NOUN', '名词', 3, '复数、可数与不可数、所有格、冠词'],
  ['GR.NOUN.PLURAL', '名词复数', 3, '单数变复数'],
  ['GR.NOUN.PLURAL.REG', '规则复数', 3, '+s / +es / 辅音+y→ies / f(e)→ves：books, boxes, babies, knives'],
  ['GR.NOUN.PLURAL.IRR', '不规则复数', 4, 'child→children, man→men, foot→feet, sheep/fish 单复数同形'],
  ['GR.NOUN.COUNT', '可数与不可数名词', 4, '可数/不可数的判断，some 与 any'],
  ['GR.NOUN.COUNT.SOMEANY', 'some 与 any', 4, '肯定句用 some，否定句和疑问句用 any'],
  ['GR.NOUN.POSS', '名词所有格', 4, "Tom's book, the teachers' office"],
  ['GR.NOUN.ARTICLE', '冠词', 3, 'a / an / the 及零冠词'],
  ['GR.NOUN.ARTICLE.A_AN', 'a 与 an', 3, '按音标开头选择：an apple, a university'],

  // ───── 代词 GR.PRON ─────
  ['GR.PRON', '代词', 3, '人称代词、物主代词、指示代词'],
  ['GR.PRON.PERSONAL', '人称代词', 3, '主格 I/you/he/she/it/we/they，宾格 me/him/her/us/them'],
  ['GR.PRON.POSS', '物主代词', 3, 'my / your / his / her / its / our / their；mine / yours …'],
  ['GR.PRON.POSS.ADJ', '形容词性物主代词', 3, 'my, your, his, her, our, their + 名词'],
  ['GR.PRON.POSS.NOUN', '名词性物主代词', 5, 'mine, yours, his, hers, ours, theirs：Whose is it? It\'s mine'],
  ['GR.PRON.DEMO', '指示代词', 3, 'this / that / these / those 及相应的回答'],
  ['GR.PRON.INDEF', '不定代词', 6, 'something, anything, everyone, nothing'],

  // ───── 数词 GR.NUM ─────
  ['GR.NUM', '数词', 3, '基数词、序数词、时间与价格表达'],
  ['GR.NUM.CARD', '基数词', 3, 'one … one hundred，十几与几十的拼写'],
  ['GR.NUM.ORD', '序数词', 5, 'first, second, third, fifth, twelfth；日期'],
  ['GR.NUM.TIME', '钟点与日期表达', 4, "It's 7:30 / half past seven；月份日期读写"],

  // ───── 介词 GR.PREP ─────
  ['GR.PREP', '介词', 3, '方位、时间及固定搭配'],
  ['GR.PREP.PLACE', '方位介词', 3, 'in, on, under, behind, in front of, next to, near, between'],
  ['GR.PREP.TIME', '时间介词', 4, 'in the morning / on Monday / at 6:30 / in May'],
  ['GR.PREP.COLLOC', '介词固定搭配', 4, "time for + 名词 / time to + 动词；look at, listen to, thank you for"],

  // ───── 动词与情态动词 GR.VERB ─────
  ['GR.VERB', '动词与情态动词', 3, 'be 动词、have/has、情态动词、祈使句、动词形式'],
  ['GR.VERB.BE', 'be 动词', 3, 'am / is / are（现在）、was / were（过去）的选择与缩略式'],
  ['GR.VERB.HAVE', 'have / has', 4, '主语为第三人称单数用 has；has/have 的否定与疑问'],
  ['GR.VERB.MODAL', '情态动词', 4, '后接动词原形，没有人称变化'],
  ['GR.VERB.MODAL.CAN', 'can / can\'t', 3, '能力、许可：Can I … ? Yes, you can'],
  ['GR.VERB.MODAL.SHOULD', 'should / must', 5, '建议与义务：We should save water. You must not …'],
  ['GR.VERB.MODAL.WOULD', 'would like / want', 4, 'I\'d like …; Would you like … ?'],
  ['GR.VERB.IMPER', '祈使句与 Let\'s', 3, 'Open the door. Don\'t run. Let\'s go'],
  ['GR.VERB.FORM', '动词形式变化', 4, '动词的各种变形规则'],
  ['GR.VERB.FORM.THIRD', '第三人称单数', 4, '-s / -es / -ies：likes, watches, studies, has'],
  ['GR.VERB.FORM.ING', '动词 -ing 形式', 5, '直接加 ing / 去 e 加 ing / 双写加 ing：making, running'],
  ['GR.VERB.FORM.ED', '动词过去式变化', 5, '加 ed / 加 d / 双写 / 变 y 为 ied'],
  ['GR.VERB.NONFIN', '动词搭配（doing / to do）', 6, 'like doing, want to do, enjoy doing, let sb. do'],

  // ───── 时态 GR.TENSE ─────
  ['GR.TENSE', '时态', 4, '一般现在时、现在进行时、一般过去时、一般将来时'],
  ['GR.TENSE.PRES', '一般现在时', 4, '经常性、习惯性动作与客观事实，often / every day'],
  ['GR.TENSE.PRES.THIRD', '一般现在时：第三人称单数', 4, 'He likes … / She goes …'],
  ['GR.TENSE.PRES.AUX', '一般现在时：do / does 否定与疑问', 4, "I don't like …; Does he play …? Yes, he does"],
  ['GR.TENSE.PRES_CONT', '现在进行时', 5, 'be + doing 的结构、否定与疑问；根据 now / Look! / Listen! 判断时态'],
  ['GR.TENSE.PAST', '一般过去时', 5, '过去发生的动作，yesterday / last weekend / ago'],
  ['GR.TENSE.PAST.REG', '规则动词过去式', 5, 'played, watched, visited, studied, stopped'],
  ['GR.TENSE.PAST.IRREG', '不规则动词过去式', 5, 'went, saw, had, did, ate, took, bought, was/were'],
  ['GR.TENSE.PAST.AUX', '一般过去时：did 否定与疑问', 5, "didn't + 动词原形；Did you … ? Yes, I did"],
  ['GR.TENSE.FUT', '一般将来时', 6, 'tomorrow / next week / this evening'],
  ['GR.TENSE.FUT.GOING', 'be going to', 6, 'I\'m going to visit …; What are you going to do?'],
  ['GR.TENSE.FUT.WILL', 'will', 6, 'It will be sunny tomorrow. I will help you'],
  ['GR.TENSE.CONTRAST', '时态综合辨析', 6, '同一题中比较多种时态，靠时间状语判断'],

  // ───── 形容词与副词 GR.ADJ ─────
  ['GR.ADJ', '形容词与副词', 4, '比较级、最高级、副词'],
  ['GR.ADJ.USE', '形容词用法', 3, '描述外貌、颜色、感受；形容词在名词前/系动词后'],
  ['GR.ADJ.COMPARE', '比较级', 6, '两者比较'],
  ['GR.ADJ.COMPARE.REG', '规则比较级', 6, 'taller, bigger, heavier, more beautiful'],
  ['GR.ADJ.COMPARE.IRR', '不规则比较级', 6, 'good→better, bad→worse, many/much→more'],
  ['GR.ADJ.COMPARE.THAN', 'than 与 as … as', 6, 'A is taller than B；as … as；Which is … , A or B?'],
  ['GR.ADJ.SUPER', '最高级（初步）', 6, 'the tallest, the most popular；one of the …'],
  ['GR.ADJ.ADV', '副词', 5, '副词的位置与形式'],
  ['GR.ADJ.ADV.FREQ', '频度副词', 5, 'always, usually, often, sometimes, never'],

  // ───── 句型 GR.SENT ─────
  ['GR.SENT', '句型', 3, 'There be、疑问句、否定句、感叹句、连词'],
  ['GR.SENT.THEREBE', 'There be 句型', 4, 'There is / are …，就近原则，否定与疑问'],
  ['GR.SENT.YESNO', '一般疑问句与简略回答', 3, 'Yes, … / No, … 的回答'],
  ['GR.SENT.YESNO.BE', 'be 动词一般疑问句', 3, 'Is this …? Are these …? Yes, it is. / No, they aren\'t'],
  ['GR.SENT.YESNO.DO', '实义动词一般疑问句', 4, 'Do / Does / Did … ? Yes, I do. / No, he doesn\'t'],
  ['GR.SENT.YESNO.MODAL', '情态动词一般疑问句', 4, 'Can I …? Yes, you can. / Should we …?'],
  ['GR.SENT.WH', '特殊疑问句', 3, '用疑问词提问并回答'],
  ['GR.SENT.WH.WHAT', 'what 类疑问句', 3, 'What is this? What\'s the weather like? What do you do?'],
  ['GR.SENT.WH.WHERE', 'where 类疑问句', 3, 'Where is / are …?'],
  ['GR.SENT.WH.WHO', 'who / whose / which', 4, 'Who is she? Whose pants are these? Which do you like?'],
  ['GR.SENT.WH.TIME', '时间类疑问句', 4, 'What time is it? When do you …? What day is it today?'],
  ['GR.SENT.WH.HOW', 'how 类疑问句', 4, 'How much / How many / How old / How tall / How do you go …?'],
  ['GR.SENT.NEG', '否定句', 3, 'am not / isn\'t / don\'t / didn\'t / can\'t / won\'t'],
  ['GR.SENT.EXCL', '感叹句', 5, 'What a …! / How …!'],
  ['GR.SENT.CONJ', '连词与复合句', 5, 'and, but, or, so, because；when, if 引导的简单从句'],
  ['GR.SENT.ORDER', '词序与句子成分', 3, '主谓宾定状的基本语序、连词成句时的排序'],

  // ───── 功能交际 FN ─────
  ['FN', '功能交际', 3, '日常交际用语与情境应答'],
  ['FN.GREET', '问候与介绍', 3, 'Hello / How are you? / Nice to meet you / This is …'],
  ['FN.SHOP', '购物', 4, 'Can I help you? How much is / are …? I\'ll take it'],
  ['FN.SHOP.PRICE', '购物：询问价格', 4, 'How much is this skirt? It\'s 80 yuan'],
  ['FN.DIR', '问路与指路', 6, 'Where is the …? Turn left / go straight / It\'s next to …'],
  ['FN.WEATHER', '谈论天气', 4, 'What\'s the weather like today? It\'s sunny and warm'],
  ['FN.TIME', '询问时间与日期', 4, 'What time is it? It\'s time for …'],
  ['FN.SUGGEST', '建议与邀请', 4, "Let's … / Would you like …? / What about …? / Why not …?"],
  ['FN.POLITE', '礼貌用语', 3, 'Thank you / You\'re welcome / Sorry / Excuse me / Pardon?'],
  ['FN.DESCRIBE', '描述人与物', 4, '外貌、能力、喜好；What\'s he like? He\'s tall and strong'],
  ['FN.PLAN', '谈论计划与经历', 6, 'What did you do last weekend? What are you going to do?'],
  ['FN.DIALOG', '补全对话与情境应答', 3, '根据情境选择或补全合适的话语'],

  // ───── 听力 LS ─────
  ['LS', '听力理解', 3, '听力题所考查的听辨能力；具体语言点能判断时优先标注语言点本身'],
  ['LS.WORD', '听音辨词', 3, '听单词/字母，选出所听内容'],
  ['LS.SENT', '听句子选图或应答', 3, '听句子，选图或选出恰当的回答'],
  ['LS.DIALOG', '听对话选答案', 4, '听短对话，回答细节问题'],
  ['LS.INFO', '听取关键信息', 4, '听数字、时间、价格、地点等关键信息并记录'],

  // ───── 阅读 RD ─────
  ['RD', '阅读理解', 4, '语篇阅读与阅读技能'],
  ['RD.DETAIL', '细节理解', 4, '根据短文直接找答案'],
  ['RD.DETAIL.FACT', '事实细节', 4, 'who / what / where / when 类细节信息提取'],
  ['RD.DETAIL.TF', '判断正误', 4, '阅读后判断句子 T / F'],
  ['RD.INFER', '推理判断', 5, '根据上下文推断'],
  ['RD.INFER.WORD', '词义猜测', 6, '根据上下文猜测生词意思'],
  ['RD.INFER.REASON', '因果与推断', 6, '推断原因、结果、人物态度'],
  ['RD.MAIN', '主旨大意', 5, '段落大意、标题匹配、短文主题'],
  ['RD.CLOZE', '完形与选词填空', 5, '在语篇中选择或填入合适的词'],
  ['RD.CLOZE.WORD', '词汇选择填空', 5, '从词库或选项中选出合适的词'],
  ['RD.SKILL', '阅读技能', 4, '排序、匹配等'],
  ['RD.SKILL.ORDER', '句子或段落排序', 5, '把打乱的句子排成通顺的对话/短文'],
  ['RD.SKILL.MATCH', '图文或问答匹配', 3, '连线：图与词、问句与答句匹配'],

  // ───── 写作 WR ─────
  ['WR', '写作与书面表达', 3, '单词、句子、短文书写'],
  ['WR.WORD', '单词书写', 3, '默写、按要求写单词'],
  ['WR.WORD.FORM', '按要求变形写词', 4, '写复数、反义词、缩写、过去式等'],
  ['WR.ORDER', '连词成句', 4, '把单词排列成正确的句子，注意大小写与标点'],
  ['WR.TRANSFORM', '句型转换', 5, '改为否定句/疑问句，对划线部分提问'],
  ['WR.PICTURE', '看图写话', 4, '根据图片写句子或短文'],
  ['WR.EXPR', '书面表达', 5, '按话题写短文'],
  ['WR.EXPR.PRESENT', '书面表达：一般现在时话题', 5, '介绍自己、家人、学校、日常作息'],
  ['WR.EXPR.PAST', '书面表达：一般过去时话题', 5, '假期、周末、旅行回顾'],
  ['WR.EXPR.FUTURE', '书面表达：一般将来时话题', 6, '计划、打算、梦想'],
]

/** [代码, 名称, 分组, 说明]；必须含 OTHER 兜底项（P1 提示词的要求） */
export type QtypeSeed = [code: string, name: string, group: 'listening' | 'written', note: string]

/** 同上，v5 迁移写入的题型种子，冻结 */
export const QTYPE_SEEDS_V1: QtypeSeed[] = [
  ['LS_WORD', '听音辨词', 'listening', '听录音，选出听到的单词或字母'],
  ['LS_PIC', '听音选图', 'listening', '听录音，给图片标号或选出对应的图'],
  ['LS_JUDGE', '听音判断', 'listening', '听录音，判断句子或图片的对错（T/F、√×）'],
  ['LS_CHOICE', '听对话选答案', 'listening', '听对话或短文，回答选择题'],
  ['LS_FILL', '听音填空', 'listening', '听录音，补全单词、数字或句子'],
  ['LS_ORDER', '听音排序', 'listening', '听录音，给图片或句子排序'],
  ['PH_DIFF', '语音辨析', 'written', '选出画线部分读音不同的词'],
  ['VO_CLASS', '词汇分类（选出不同类）', 'written', '选出不属于同一类的单词'],
  ['PIC_WORD', '看图选词/写词', 'written', '看图片，选择或写出对应的单词'],
  ['MC', '单项选择', 'written', '四选一/三选一的语法、词汇、句型选择'],
  ['FORM', '用所给词的适当形式填空', 'written', '也包括按要求写出单词的另一种形式'],
  ['MATCH', '连线与匹配', 'written', '图与词、问句与答句连线匹配'],
  ['DIALOG', '补全对话', 'written', '从选项中选句子补全对话'],
  ['CLOZE', '完形填空/选词填空', 'written', '在短文空格中填入合适的词'],
  ['RD_TF', '阅读判断', 'written', '阅读短文，判断句子正误'],
  ['RD_MC', '阅读选择', 'written', '阅读短文，选择正确答案'],
  ['ORDER', '连词成句', 'written', '把单词排成正确的句子'],
  ['TRANSFORM', '句型转换', 'written', '改写句子（否定、疑问、对划线部分提问）'],
  ['FILL', '填空', 'written', '根据提示或中文补全句子'],
  ['TRANSLATE', '翻译', 'written', '汉译英或英译汉'],
  ['WRITE', '书面表达', 'written', '写短文或看图写话'],
  ['OTHER', '其他', 'written', '以上都不合适时使用']
]

export interface KpRow {
  code: string
  parent_code: string | null
  name: string
  level: number
  intro_grade: number
  sort: number
  note: string
}

/** 由代码前缀推导 parent_code 与 level；父节点按「去掉最后一段后仍存在的最长前缀」确定 */
export function buildKpRows(seeds: KpSeed[] = KP_SEEDS_V1): KpRow[] {
  const codes = new Set(seeds.map(s => s[0]))
  const levelOf = new Map<string, number>()
  const rows: KpRow[] = []
  seeds.forEach(([code, name, introGrade, note], i) => {
    const parts = code.split('.')
    let parent: string | null = null
    for (let n = parts.length - 1; n >= 1; n--) {
      const cand = parts.slice(0, n).join('.')
      if (codes.has(cand)) { parent = cand; break }
    }
    const level = parent ? (levelOf.get(parent) ?? 1) + 1 : 1
    levelOf.set(code, level)
    rows.push({ code, parent_code: parent, name, level, intro_grade: introGrade, sort: (i + 1) * 10, note })
  })
  return rows
}
