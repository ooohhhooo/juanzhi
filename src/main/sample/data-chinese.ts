/**
 * 示例数据：合成的小学语文卷子（3–6 年级，题目和阅读短文都是编写的演示内容，不是任何真实学校的试卷，也不摘抄课文原文）。
 * 8 份 = 三年级 2 份（2024 学年）+ 四年级 4 份（2024、2025 两个学年 × 期中 + 期末，同比用）+ 五年级 1 份 + 六年级 1 份。
 * 「看拼音写词语」整题算一道；阅读题把短文和问题写在同一道题的题干里；习作带题目要求。
 * 纯数据，知识点与题型代码取自内置语文种子（taxonomy-chinese.ts）。
 */
import type { SamplePaper, SampleQ } from './data.ts'

const q = (qtype: string, kp: string, score: number, diff: number, stem: string, options: string[] = [], answer = '', err = '', sec: string[] = [], flags: string[] = []): SampleQ =>
  ({ qtype, kp, score, diff, stem, options, answer, err: err || undefined, sec, flags })

export const CHINESE_POOL: Record<string, SampleQ> = {
  // ── 字音字形 ──
  cnPy3: q('CN_PY_WRITE', 'CN.CHAR.WRITE.SPELL', 8, 2, '看拼音，写词语。 péng you（      ）  jì zhù（      ）  guān chá（      ）  zhì huì（      ）', [], '朋友 记住 观察 智慧', '「察」「慧」笔画多，容易少写一笔'),
  cnPy5: q('CN_PY_WRITE', 'CN.CHAR.WRITE.SPELL', 8, 3, '看拼音，写词语。 xiāo huǐ（      ）  chōng pèi（      ）  zhuāng yán（      ）  qiān xū（      ）', [], '销毁 充沛 庄严 谦虚', '「毁」的左下部分是「工」，容易写成「土」'),
  cnZhuyin: q('CN_ZHUYIN', 'CN.CHAR.SOUND.CONFUSE', 4, 3, '选择加点字的正确读音，画「√」。 倔强（jiàng  qiáng）  星宿（sù  xiù）  提防（dī  tí）', [], 'jiàng xiù dī', '多音字按常见读音读，没有联系词语的意思'),
  cnChoiceSound: q('CN_CHOICE', 'CN.CHAR.SOUND.CONFUSE', 3, 3, '下列词语中加点字读音完全正确的一项是（  ）。', ['A. 空隙（xì） 差使（chāi）', 'B. 咳嗽（hāi） 横财（héng）', 'C. 勉强（qiǎng） 创伤（chuāng）', 'D. 混淆（xiáo） 拾级（shè）'], 'A', '「创伤」的「创」读 chuāng，「创造」的「创」读 chuàng'),
  cnPoly: q('CN_POLY', 'CN.CHAR.SOUND.POLY', 4, 2, '给多音字注音并组词。 长（    ）（      ）  好（    ）（      ）  行（    ）（      ）', [], '', '同一个字不同读音意思不同，组的词要和读音对应'),
  cnStroke: q('CN_STROKE', 'CN.CHAR.FORM.STROKE', 3, 2, '「必」字一共（  ）画，第三笔是（    ）。', [], '5 撇', '笔顺凭感觉写，卧钩和斜钩分不清'),
  cnDict: q('CN_DICT', 'CN.CHAR.DICT.PINYIN', 4, 3, '用音序查字法查「蕴」字，先查大写字母（  ），再查音节（      ）；用部首查字法，先查部首（  ），再查（  ）画。', [], 'Y yùn 艹 10', '除去部首的笔画数，容易把部首也数进去'),
  cnTypo: q('CN_TYPO', 'CN.CHAR.FORM.TYPO', 4, 3, '找出下面句子中的错别字，并改正。 ① 他把书整里得整整齐齐。 ② 我们要发杨团结互助的精神。', [], '整理 发扬', '同音字、形近字不看意思就写'),
  cnSimilar: q('CN_TYPO', 'CN.CHAR.FORM.SIMILAR', 4, 3, '选字填空。（辩  辨）我们要学会（  ）别是非；在（  ）论赛上他据理力争。', [], '辨 辩', '「辨」「辩」只差一个偏旁，意思不同'),
  cnBuild: q('CN_ZUCI', 'CN.CHAR.FORM.BUILD', 4, 2, '给「青」加偏旁组成新字，再组词。 青+氵=（  ）（      ）  青+日=（  ）（      ）  青+讠=（  ）（      ）', [], '清 晴 请'),
  // ── 词语 ──
  cnZuci: q('CN_ZUCI', 'CN.WORD.BUILD.ZUCI', 4, 1, '给下面的字组词。 玩（      ）  完（      ）  园（      ）  圆（      ）', [], ''),
  cnSynAnt: q('CN_SYN_ANT', 'CN.WORD.MEAN.SYN', 4, 2, '写出近义词或反义词。 仔细——（      ）  勇敢↔（      ）  渐渐——（      ）  诚实↔（      ）', [], '认真 胆小 慢慢 虚伪', '近义词和反义词要求看不清，写反了', ['CN.WORD.MEAN.ANT']),
  cnMeasure: q('CN_WORD_FILL', 'CN.WORD.BUILD.MEASURE', 3, 1, '在括号里填上合适的量词。 一（  ）彩虹  一（  ）鱼  一（  ）灯', [], '道 条 盏', '量词搭配凭习惯，换一个对象就用错'),
  cnConj: q('CN_WORD_FILL', 'CN.SENT.CONJ', 4, 2, '选择合适的关联词填空。（虽然……但是……  因为……所以……）（    ）今天下着大雨，（    ）同学们还是准时到校了。', [], '虽然 但是', '前后关联词要成对，意思要对得上'),
  cnChoose: q('CN_WORD_FILL', 'CN.WORD.MEAN.CHOOSE', 3, 3, '选词填空。（发扬  发挥）我们要（    ）团结互助的精神，让每个人都能（    ）自己的长处。', [], '发扬 发挥', '两个词意思相近，没有看后面搭配的词'),
  cnIdiom: q('CN_IDIOM', 'CN.WORD.IDIOM.FILL', 4, 2, '补全成语。 画龙点（  ）  守株待（  ）  亡羊补（  ）  掩耳盗（  ）', [], '睛 兔 牢 铃', '成语里的字写成同音字，如「点精」'),
  cnIdiomUse: q('CN_IDIOM', 'CN.WORD.IDIOM.USE', 3, 4, '下列句子中，成语使用恰当的一项是（  ）。', ['A. 他说话总是滔滔不绝，我们都很佩服他的沉默寡言。', 'B. 这位老画家的作品栩栩如生，令人叹为观止。', 'C. 看到这么多人，我心里不禁忐忑不安，一筹莫展地走进考场。', 'D. 他做事总是半途而废，这种持之以恒的精神值得学习。'], 'B', '只看成语的字面意思就判断，没有联系整句话'),
  cnSaying: q('CN_IDIOM', 'CN.WORD.IDIOM.SAYING', 3, 2, '把歇后语补充完整。 哑巴吃黄连——（        ）  瞎子点灯——（        ）', [], '有苦说不出 白费蜡', '歇后语后半句凭印象写，写成相近的说法'),
  // ── 句子 ──
  cnPunc: q('CN_PUNC', 'CN.SENT.PUNC.QUOTE', 4, 2, '给句子加上合适的标点。 妈妈说____明天我们去公园____ 小明问____你去过长城吗____', [], '：“ 。” ：“ ？”', '提示语在前面用冒号，说话内容两端要加引号'),
  cnImitate: q('CN_SENT_IMITATE', 'CN.SENT.IMITATE', 4, 2, '照样子写句子。 例：天空像一块蓝宝石。 ____________像____________。', [], ''),
  cnRhet: q('CN_CHOICE', 'CN.SENT.RHET.PERSON', 2, 2, '下面句子运用了拟人手法的一句是（  ）。', ['A. 月亮像一个大圆盘。', 'B. 小草从土里探出头来，笑眯眯地看着我。', 'C. 他跑得像风一样快。', 'D. 荷叶上滚着晶莹的露珠。'], 'B', '把比喻和拟人混在一起'),
  cnBaBei: q('CN_SENT_REWRITE', 'CN.SENT.FORM.BABEI', 4, 3, '按要求改写句子。 ① 小明打碎了花瓶。（改成「被」字句）  ② 风吹走了我的帽子。（改成「把」字句）', [], '花瓶被小明打碎了。 风把我的帽子吹走了。', '改成「被」字句时，做事的人和受事的物位置换错'),
  cnRhetQ: q('CN_SENT_REWRITE', 'CN.SENT.FORM.RHETQ', 4, 3, '按要求改写句子。 ① 这是一个多么美丽的地方！（改成反问句）  ② 难道我们不应该爱护环境吗？（改成陈述句）', [], '', '改反问句或陈述句后，意思变了'),
  cnQuote: q('CN_SENT_REWRITE', 'CN.SENT.FORM.QUOTE', 4, 4, '把直接引语改成转述句。 老师对小明说：“你明天要参加比赛。”', [], '老师对小明说，他明天要参加比赛。', '转述后人称没有变，引号也没去掉'),
  cnExpand: q('CN_SENT_REWRITE', 'CN.SENT.FORM.EXPAND', 4, 3, '缩句。 一只可爱的小松鼠在高高的松树上跳来跳去。 缩成：__________', [], '小松鼠跳。', '缩句时只能删去修饰成分，容易把主要意思也删了'),
  cnFix: q('CN_SENT_FIX', 'CN.SENT.FIX', 4, 4, '修改病句。 ① 通过这次活动，使我们增长了知识。 ② 我们要养成讲卫生的好习惯，防止不再生病。', [], '', '先判断病句的类型：缺主语、搭配不当还是重复啰嗦'),
  cnOrder: q('CN_SENT_ORDER', 'CN.SENT.ORDER', 4, 3, '把下列句子排成通顺的一段话，填序号。 ①小鸟们叽叽喳喳地叫着。 ②天亮了。 ③太阳慢慢升起来了。 ④我推开窗户。', [], '②④③①', '没有按时间先后顺序读一遍'),
  // ── 古诗文积累 ──
  cnPoem3: q('CN_POEM', 'CN.ACCU.POEM.RECITE', 6, 2, '古诗默写。 春眠不觉晓，（          ），夜来风雨声，（          ）。 欲穷千里目，（          ）。', [], '处处闻啼鸟 花落知多少 更上一层楼', '「闻」「啼」等字写成同音字', ['CN.ACCU.POEM.AUTHOR']),
  cnPoem4: q('CN_POEM', 'CN.ACCU.POEM.RECITE', 6, 3, '古诗默写。 竹外桃花三两枝，（          ）。春风又绿江南岸，（          ）。', [], '春江水暖鸭先知 明月何时照我还', '「绿」「照」容易写成近音字'),
  cnPoemWord: q('CN_POEM', 'CN.ACCU.POEM.WORD', 3, 3, '「欲穷千里目」中「穷」的意思是（    ）；「更上一层楼」中「更」的意思是（    ）。', [], '尽，看到尽头 再', '把「穷」当成「贫穷」，用现代意思去解释'),
  cnPoemMean: q('CN_POEM', 'CN.ACCU.POEM.MEANING', 4, 4, '「春江水暖鸭先知」一句中，诗人为什么说「鸭先知」？这句话表达了诗人怎样的感受？', [], '', '只翻译字面意思，没有说出诗人对春天的喜爱'),
  cnPoem5: q('CN_POEM', 'CN.ACCU.POEM.RECITE', 6, 3, '默写。 不畏浮云遮望眼，（          ）。 野火烧不尽，（          ）。 己所不欲，（          ）。', [], '自缘身在最高层 春风吹又生 勿施于人', '「缘」「施」等字写错'),
  cnMotto: q('CN_RECITE', 'CN.ACCU.MOTTO', 4, 2, '日积月累填空。 读书破万卷，（          ）。 三人行，（          ），择其善者而从之。', [], '下笔如有神 必有我师', '名言只记了上半句'),
  cnClassic6: q('CN_READ_IN', 'CN.ACCU.CLASSIC.TRANS', 5, 4, '阅读文言文片段。“弈秋，通国之善弈者也。使弈秋诲二人弈，其一人专心致志，惟弈秋之为听；一人虽听之，一心以为有鸿鹄将至，思援弓缴而射之。虽与之俱学，弗若之矣。” 把「虽与之俱学，弗若之矣」翻译成现代汉语。', [], '虽然和前一个人一起学习，但是他的成绩比不上前一个人。', '「虽」「弗」「若」逐字对应时漏翻译，或者把「弗」当成「不」之外的意思'),
  cnJudgeCulture: q('CN_JUDGE', 'CN.ACCU.CULTURE', 2, 2, '「重阳节」是农历九月初九，有登高、赏菊的习俗。（  ）', [], '√'),
  // ── 阅读 ──
  cnReadIn3: q('CN_READ_IN', 'CN.READ.SKILL.LOCATE', 6, 2, '读短文，回答问题。 秋天来了，树叶黄了，一片片叶子像小船一样飘落下来。小蚂蚁爬到一片叶子上，叶子带着它在水面上漂啊漂。 ① 短文写的是哪个季节？（  ） ② 小蚂蚁坐在什么上面？（  ）', [], '秋天 叶子（小船）', '回答问题没有回到短文里找原句'),
  cnReadIn3b: q('CN_READ_IN', 'CN.READ.SKILL.WORDS', 6, 3, '读短文，回答问题。 放学路上下起了大雨，小华把伞举到了同桌小林的头顶上，自己的半个肩膀却被淋湿了。小林说：“你的衣服湿了！”小华笑着说：“没关系，快走吧。” ① 联系上下文，说说「没关系」这句话说明小华是个怎样的人。 ② 你从这件事里学到了什么？', [], '', '联系上下文理解词句，容易只写「他很好」，说不出依据'),
  cnReadOut4: q('CN_READ_OUT', 'CN.READ.SKILL.WORDS', 8, 3, '读短文，回答问题。 他一边慢条斯理地整理书包，一边听窗外的雨声。“再不走就要迟到了！”妈妈在门口催促。他还是不紧不慢地把铅笔一支支放进笔盒。 ① 「慢条斯理」在文中的意思是（  ） ② 从哪些动作能看出他不着急？请找出两处。 ③ 妈妈的心情是怎样的？', [], '', '联系上下文理解词语时，只靠字面去猜'),
  cnReadSum4: q('CN_READ_OUT', 'CN.READ.SKILL.SUMMARY', 6, 3, '读短文，用一句话概括主要内容。 社区里的王爷爷每天清晨都会把落叶扫成一堆，再装进袋子里运走。有一次下雨，他怕积水堵住下水口，冒着雨把落叶清走了。邻居们都说，有他在，小区总是干干净净的。', [], '王爷爷每天认真打扫小区，让小区保持干净。', '概括时照抄第一句，没有写清「谁做了什么」'),
  cnReadTheme5: q('CN_READ_OUT', 'CN.READ.SKILL.THEME', 8, 4, '读短文，回答问题。 父亲每个月都从山里寄来一个包裹，里面是晒干的野菜和一张字条，字条上只有四个字：“好好吃饭。”我嫌麻烦，从没回过信。直到有一天，我在包裹里发现一双布鞋，鞋底纳得又密又厚。 ① 「好好吃饭」这四个字表达了父亲怎样的感情？ ② 读完最后一句，你有什么感受？', [], '', '体会情感时只写表面的意思，没有联系细节'),
  cnReadChar5: q('CN_READ_IN', 'CN.READ.SKILL.CHARACTER', 6, 4, '读片段，回答问题。 老渔夫把网拉上来，网里只有几条小鱼。他看了看，又把小鱼放回水里，说：“再长大些，明年还来。”旁边的年轻人不解地笑了。 这段话通过什么描写表现了老渔夫怎样的特点？', [], '语言、动作描写，表现他爱惜自然、目光长远。', '分析人物时只说「他很善良」，没有抓住描写方法'),
  cnReadExpo6: q('CN_READ_OUT', 'CN.READ.GENRE.EXPO', 6, 4, '读说明文片段，回答问题。 “地球的表面积约有 5.1 亿平方千米，其中海洋约占 71%。如果把地球比作一个橘子，那海洋就是橘子皮上的一层薄薄的水。” 这几句话主要运用了哪几种说明方法？', [], '列数字、打比方', '列数字、作比较、打比方三种说明方法容易混'),
  cnNoncont: q('CN_READ_OUT', 'CN.READ.GENRE.NONCONT', 6, 3, '阅读下面的《图书借阅须知》，回答问题。 开放时间：周一至周五 8:00—17:00；每人每次限借 3 本，借期 14 天；逾期未还，每天罚款 0.1 元。 小丽周五 16:30 想借书，她能借几本？借期到哪天结束？如果逾期 5 天，要付多少钱？', [], '3 本；14 天后；0.5 元', '读非连续性文本时漏看条件，把借期当成罚款天数'),
  // ── 表达 ──
  cnOral: q('CN_ORAL', 'CN.ORAL.SCENE', 4, 2, '口语交际。 同桌借了你的橡皮一直没有还，你该怎么跟他说？请写出你的话。', [], '', '话说得太生硬，没有考虑对方的感受'),
  cnOral6: q('CN_ORAL', 'CN.ORAL.PERSUADE', 4, 3, '口语交际。 同桌上课总喜欢做小动作，你想劝劝他。请写出你的话（要有礼貌，要讲道理）。', [], '', '只提要求，没有讲出这样做对他和别人的影响'),
  cnEssay3: q('CN_ESSAY', 'CN.WRITE.EVENT', 30, 3, '习作：以「那一次，我真____」为题（先把题目补充完整），写一件印象最深的事，要写清楚事情的起因、经过和结果，不少于 300 字。', [], '', '只写结果，事情的经过没有写具体'),
  cnEssay4: q('CN_ESSAY', 'CN.WRITE.OBJECT', 30, 3, '习作：我的植物朋友。选一种你熟悉的植物，抓住它的特点来写，写出你对它的喜爱，不少于 350 字。', [], '', '只罗列特点，没有把特点写具体'),
  cnEssay4b: q('CN_ESSAY', 'CN.WRITE.PERSON', 30, 3, '习作：身边有这样一个人。通过一两件具体的事，写出这个人的特点，不少于 350 字。', [], '', '写人只说「他很好」，没有用具体的事来表现'),
  cnEssay4c: q('CN_ESSAY', 'CN.WRITE.EVENT', 30, 3, '习作：一次有趣的实验。按照实验前、实验中、实验后的顺序写，把过程写清楚，不少于 350 字。', [], '', '只写了结果，经过写得很简单'),
  cnEssay4d: q('CN_ESSAY', 'CN.WRITE.SCENE', 30, 4, '习作：家乡的春天。按一定的顺序写出春天的景色，用上你积累的好词好句，不少于 350 字。', [], '', '景物描写没有顺序，也没有写出自己的感受'),
  cnEssay5: q('CN_ESSAY', 'CN.WRITE.SCENE', 35, 4, '习作：一处难忘的景物。按照观察的顺序写，抓住特点，写出你的感受，不少于 450 字。', [], '', '景物没有抓住特点，写成了景物清单'),
  cnEssay6: q('CN_ESSAY', 'CN.WRITE.IMAGINE', 40, 4, '习作：假如我有一支神笔。展开想象，写清楚你会画什么，会发生什么，不少于 500 字。', [], '', '想象不够具体，故事前后不连贯')
}

const P = (key: string, grade: SamplePaper['grade'], semester: '上' | '下', year: number, exam: '期中' | '期末', textbook: string, qs: string[]): SamplePaper =>
  ({ key, subject: 'chinese', grade, semester, year, exam, textbook, region: '示例市', qs })

/**
 * 8 份语文示例卷。设计要点：四年级 2024 学年考「把」「被」字句、反问句、改错别字、查字典；
 * 2025 学年改考转述句、缩句、歇后语和非连续性文本，同比有「新增 / 消失」可看。
 */
export const CHINESE_PAPERS: SamplePaper[] = [
  P('c-2024-g3-mid', '3', '上', 2024, '期中', '统编版', ['cnPy3', 'cnZhuyin', 'cnPoly', 'cnZuci', 'cnSynAnt', 'cnMeasure', 'cnPunc', 'cnPoem3', 'cnReadIn3', 'cnEssay3']),
  P('c-2024-g3-fin', '3', '下', 2024, '期末', '统编版', ['cnPy3', 'cnDict', 'cnBuild', 'cnIdiom', 'cnConj', 'cnImitate', 'cnStroke', 'cnMotto', 'cnReadIn3b', 'cnEssay3']),
  P('c-2024-g4-mid', '4', '上', 2024, '期中', '统编版', ['cnPy3', 'cnZhuyin', 'cnPoly', 'cnTypo', 'cnIdiom', 'cnBaBei', 'cnRhet', 'cnPoem4', 'cnReadOut4', 'cnEssay4']),
  P('c-2024-g4-fin', '4', '下', 2024, '期末', '统编版', ['cnPy3', 'cnDict', 'cnSimilar', 'cnSynAnt', 'cnIdiomUse', 'cnRhetQ', 'cnFix', 'cnPoemWord', 'cnReadSum4', 'cnEssay4b']),
  P('c-2025-g4-mid', '4', '上', 2025, '期中', '统编版', ['cnPy3', 'cnChoiceSound', 'cnPoly', 'cnIdiom', 'cnSaying', 'cnQuote', 'cnExpand', 'cnMotto', 'cnNoncont', 'cnEssay4c']),
  P('c-2025-g4-fin', '4', '下', 2025, '期末', '统编版', ['cnPy3', 'cnZhuyin', 'cnTypo', 'cnChoose', 'cnQuote', 'cnFix', 'cnPoemMean', 'cnOrder', 'cnReadOut4', 'cnEssay4d']),
  P('c-2025-g5-mid', '5', '上', 2025, '期中', '统编版', ['cnPy5', 'cnChoiceSound', 'cnIdiomUse', 'cnFix', 'cnPunc', 'cnPoem5', 'cnReadTheme5', 'cnReadChar5', 'cnEssay5']),
  P('c-2025-g6-fin', '6', '下', 2025, '期末', '统编版', ['cnPy5', 'cnDict', 'cnIdiom', 'cnClassic6', 'cnJudgeCulture', 'cnReadExpo6', 'cnReadTheme5', 'cnOral6', 'cnOral', 'cnEssay6'])
]
