/**
 * 术语白话表（B6）：界面和报告里所有「专业词」的一句话解释 + 例子。设计代理的悬停释义、词条组件都读这一份。
 * 纯数据 + 查询函数，不依赖 electron / React，单测直接加载。
 *  - term：界面上显示的词（已经是白话改写后的叫法，原来的专业叫法放 aka，搜索 / 查询时也认）；
 *  - plain：一句话讲清楚，不再用别的专业词；
 *  - example：一个例子（可空）；
 *  - aka：别名（原来的专业叫法）。
 */
export interface GlossaryEntry { term: string; plain: string; example: string; aka?: string[] }

export const GLOSSARY: GlossaryEntry[] = [
  { term: '知识点 × 题型表', plain: '一张表：每一行是一个知识点，每一列是一种题型，格子里是这类题有几道、占几分。', example: '“名词复数”那一行、“单项选择”那一列的格子写着 3 题 / 6 分。', aka: ['双向细目表'] },
  { term: '怎么算的', plain: '看板上每个数字是怎么算出来的，先看三句话，想细看再展开。', example: '', aka: ['口径', '口径说明'] },
  { term: '考了几份卷子', plain: '这个知识点在多少份卷子里出现过。', example: '3 份卷子里有 2 份考了「物主代词」。', aka: ['出现率', '出现份数'] },
  { term: '占总分多少', plain: '这个知识点的题加起来占整张卷子总分的比例。', example: '名词复数的题一共 6 分，总分 100 分，占总分 6%。', aka: ['分值占比'] },
  { term: '去年及以前', plain: '拿来比较的那几年的卷子（不含今年）。', example: '', aka: ['基线', '基线学年'] },
  { term: '今年', plain: '要看的这一学年的卷子。', example: '', aka: ['目标学年'] },
  { term: '去年没考，今年考了', plain: '这个知识点以前的卷子里一次都没出现，今年的卷子里出现了。', example: '比较级：去年及以前 0/2 份有，今年 1/1 份有。', aka: ['新增', '基线 0/N → 目标 M/N'] },
  { term: '去年考过，今年没考', plain: '这个知识点以前的卷子里出现过，今年的卷子里没有。注意：没出现不等于以后不考，卷子少时尤其如此。', example: '', aka: ['消失'] },
  { term: '只比同一学期', plain: '一学年有上、下两学期，今年往往只考完一半。打开后，只拿去年及以前“同一学期”的卷子来比（下学期对下学期）。', example: '', aka: ['按学期对齐'] },
  { term: '比例变高了 / 变低了', plain: '两边都考了，但“考了几份卷子”的比例变化很大（差 20 个百分点以上）。', example: '去年 1/4 份有，今年 3/4 份有：变高了。', aka: ['上升', '下降', '个百分点'] },
  { term: '样本不足，暂不比较', plain: '用来比的卷子少于 3 份，一两份卷子的差别就能造成“新增”“消失”，所以先不下结论。多导入几份再看。', example: '', aka: ['样本不足', '样本有限', '样本偏小'] },
  { term: '个例', plain: '只在 1 份卷子里出现过的知识点：说不上是规律，更不能说是难点。', example: '', aka: [] },
  { term: '排在前面的理由', plain: '表里的顺序 = 常考 × 占分多 × 容易错，越靠前越值得先练。不需要记公式，看“重点 / 难点”标签就行。', example: '', aka: ['综合得分', '排序公式'] },
  { term: '重点', plain: '常考、占分又多的知识点：值得先练。', example: '', aka: [] },
  { term: '难点', plain: '题目偏难，或者估计学生容易做错的知识点。', example: '', aka: [] },
  { term: '容易错', plain: 'AI 根据题目内容估计学生容易做错，不是学生真实考试成绩。', example: '', aka: ['易错', '易错率', 'AI 估计易错'] },
  { term: '难易程度', plain: '1 到 5 分，数字越大越难，是 AI 估计的，不是学生成绩。1–2 偏易，3 中等，4–5 较难。', example: '2.67 = 中等偏易。', aka: ['难度', '平均难度'] },
  { term: '需要核对', plain: 'AI 对这道题的位置、知识点或文字没把握，请对着原卷看一眼。把握高的题不会提示。', example: '', aka: ['置信度', '位置不确定', '低置信度'] },
  { term: '这题主要考什么 / 还顺带考什么', plain: '一道题可以标 1 个“主要考的知识点”，再顺带标几个“还考到的”。得分只算在主要考的那个上，避免重复计分。', example: '', aka: ['主知识点', '次知识点', '仅次知识点'] },
  { term: '包含下面所有细分', plain: '大类的数字 = 它下面所有小类加起来。所以“写作”大类的占比，比下面“书面表达”这一个小类大。', example: '', aka: ['向上汇总'] },
  { term: '课标几年级开始学', plain: '教材里这个知识点一般从几年级开始学，只是参考，不代表这份卷子的年级。', example: '', aka: ['引入年级'] },
  { term: 'AI 草稿 · 请老师核对', plain: 'AI 写出来的内容都是草稿：用之前请老师核对，尤其是讲英语规则的地方。', example: '', aka: ['AI 草稿'] },
  { term: '未核实', plain: 'AI 写的这句英语规则，在老师审核过的题目解释里找不到依据，请老师自己确认对不对。', example: '', aka: [] },
  { term: '与题目解释矛盾', plain: 'AI 写的这句规则，和老师审核过的题目解释说的不一样，很可能写错了。', example: 'AI 写“time for 后接动词”，题目解释是“time for 后接名词”。', aka: [] },
  { term: '疑似重复', plain: '这份卷子的题目，大部分在另一份已有的卷子里也有（可能是同一份卷子的一页，或重复拍了一遍）。默认不计入统计，免得同一份卷子被算两次。', example: '', aka: ['部分重复'] },
  { term: '待审核', plain: 'AI 已经把题拆好、标好了，还要老师看一遍确认；确认之前不计入统计。', example: '', aka: ['reviewing'] },
  { term: '已完成', plain: '老师已经核对并确认了整份卷子，会计入统计。', example: '', aka: ['done'] },
  { term: '文字识别', plain: '把卷子图片里的字读出来，让电脑能处理。', example: '', aka: ['OCR'] },
  { term: '管理员设置', plain: '连接 AI 服务、文字识别、提示词这类技术设置，一般不用改，请管理员处理。', example: '', aka: ['Base URL', 'API Key', '提示词', 'tokens', '输出长度上限', '并发'] },
  { term: '提示词', plain: '发给 AI 的“工作说明”。改坏了会让结果变差，一般不要改。', example: '', aka: ['prompt'] },
  { term: '内部代码', plain: '程序给知识点、题型起的英文编号，只有管理员排查问题时有用。', example: 'GR.PRON.POSS 就是“物主代词”。', aka: ['代码'] },
  { term: '画线丢失', plain: '原卷里的下划线没被识别出来（比如“选出画线部分读音不同”的题），请对着原图看。', example: '', aka: ['underline_lost'] },
  { term: '拆分 / 与下一题合并', plain: '一道题被 AI 切成了两道，或两道本来是一道时用：拆分是把一道拆成两道，合并是把本题和下一题并成一道。', example: '', aka: [] },
  { term: '已确认', plain: '这道题老师已经看过、点过“确认”。', example: '', aka: [] }
]

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 按术语或别名查（忽略空白和大小写）；找不到返回 undefined */
export function lookupTerm(term: string): GlossaryEntry | undefined {
  const t = norm(term)
  return GLOSSARY.find(g => norm(g.term) === t || (g.aka ?? []).some(a => norm(a) === t))
}

/** 文字里出现了哪些术语（用于给一段文字配悬停释义）：返回命中的词条和它在文字里的位置 */
export function findTerms(text: string): Array<{ entry: GlossaryEntry; matched: string; index: number }> {
  const out: Array<{ entry: GlossaryEntry; matched: string; index: number }> = []
  for (const g of GLOSSARY) {
    for (const w of [g.term, ...(g.aka ?? [])]) {
      if (w.length < 2) continue
      const i = text.indexOf(w)
      if (i >= 0) { out.push({ entry: g, matched: w, index: i }); break }
    }
  }
  return out.sort((a, b) => a.index - b.index)
}
