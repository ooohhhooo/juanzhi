// 学科判断与「像不像试卷」：三个学科的样例卷面、卷头明说、只有内容特征、混合、太短、教案
import assert from 'node:assert/strict'
import { detectSubject, detectDocSubject, looksLikePaper, visibleInSubject, asContentSubject, subjectColumnNote, validChars } from '../../src/shared/classify.ts'

const MATH = `三年级数学期末测试卷
姓名：______ 班级：______ 得分：______
一、直接写得数。（每题 1 分，共 8 分）
25+36=（  ） 72-18=（  ） 6×7=（  ） 48÷6=（  ）
二、列竖式计算。（共 12 分）
347+256=  805-379=  23×14=  96÷4=
三、填空。（每空 1 分）
1. 一根绳子长 3 米 50 厘米，合（  ）厘米。
2. 5 千克 200 克 =（  ）克。
四、应用题。（每题 5 分）
1. 小明买 3 本练习本，每本 4 元 5 角，一共用了多少元？
2. 一个长方形长 8 厘米，宽 5 厘米，它的周长和面积各是多少？`

const MATH_BODY = MATH.split('\n').slice(3).join('\n')   // 去掉卷头

const CHINESE = `四年级语文上册期中检测
一、看拼音，写词语。（8 分）
shān shuǐ（  ） qīng cuì（  ） huān xǐ（  ） xiàng zhēng（  ）
二、选择正确的读音，打“√”。
三、给下列词语选择合适的近义词和反义词。
四、古诗积累。默写《望庐山瀑布》。
五、阅读短文，回答问题。（共 16 分）
秋天来了，树叶黄了，一片一片落下来。像一只只小蝴蝶在空中飞舞。
1. 短文用了什么修辞手法？（  ）
六、习作。请以“我的好朋友”为题写一篇作文。`

const CHINESE_BODY = CHINESE.split('\n').slice(1).join('\n')

const ENGLISH = `PEP 小学英语五年级上册期末测试
Name: ______ Class: ______ Score: ______
一、听力部分（共 30 分）
Ⅰ. Listen and choose. 听录音，选出你所听到的单词。
1. A. apple B. banana C. orange
2. A. Monday B. Tuesday C. Wednesday
二、笔试部分
Ⅱ. Choose the correct answer. 选择正确答案。
1. What time is it? It's seven o'clock. I get up (  ) the morning.
2. Does she like playing basketball? Yes, she does. She often plays it with her friends after school.
Ⅲ. Read and answer. Look at the picture and write the sentences. Mike is a student. He goes to school by bus every day.
Ⅳ. Fill in the blanks with the words in the box: breakfast lunch dinner eat drink`

const ENGLISH_BODY = ENGLISH.split('\n').slice(2).join('\n')

// ── 三个学科：卷头明说 ──
for (const [name, text, sub] of [['数学', MATH, 'math'], ['语文', CHINESE, 'chinese'], ['英语', ENGLISH, 'english']]) {
  const r = detectSubject(text)
  assert.equal(r.subject, sub, name)
  assert.equal(r.sure, true, name + ' 有把握')
}
assert.match(detectSubject(MATH).reason, /数学/)
// 标题单独说明学科（文件名），正文没有卷头
assert.equal(detectSubject(MATH_BODY, '四年级 数学 期末').subject, 'math')
assert.equal(detectSubject(MATH_BODY, '四年级 数学 期末').sure, true)

// ── 只有内容特征（没有卷头）──
{
  const m = detectSubject(MATH_BODY)
  assert.equal(m.subject, 'math'); assert.equal(m.sure, true, '数学内容特征压倒性')
  const c = detectSubject(CHINESE_BODY)
  assert.equal(c.subject, 'chinese'); assert.equal(c.sure, true, '语文内容特征压倒性')
  const e = detectSubject(ENGLISH_BODY)
  assert.equal(e.subject, 'english'); assert.equal(e.sure, true, '英语内容特征压倒性')
}

// ── 混合：不给把握 ──
{
  const mixed = detectSubject(MATH_BODY + '\n' + ENGLISH_BODY + '\n' + CHINESE_BODY)
  assert.equal(mixed.sure, false, '三科混在一起')
  const two = detectSubject('一、计算题 25+36= 72-18= 6×7= 48÷6= 应用题 小数 分数\n二、看拼音写词语 组词 古诗 阅读短文 近义词 反义词 成语 修辞')
  assert.equal(two.sure, false, '数学和语文特征都很强')
  // 卷头多个学科
  const both = detectSubject('语文数学综合练习\n' + CHINESE_BODY)
  assert.equal(both.sure, false)
  // 卷头说数学，内容却压倒性是语文：自相矛盾，不给把握
  const odd = detectSubject('数学\n' + CHINESE_BODY)
  assert.equal(odd.sure, false)
}

// ── 太短 ──
{
  const r = detectSubject('数学试卷')
  assert.equal(r.sure, false, '有效字不到 30 个，哪怕卷头明说也不算有把握')
  assert.equal(r.subject, 'math', '但倾向还是给')
  assert.equal(detectSubject('').subject, null)
  assert.equal(detectSubject('第一题 计算 25+36=').sure, false)
  assert.ok(validChars('数学 abc 123，。') === 8)
}

// ── 教案 / 普通文档 ──
{
  const plan = `三年级英语教案：Unit 3 My friends
一、教学目标
1. 学会单词 friend, tall, short。
二、教学重点
句型 He is tall. She has long hair.
三、教学过程
热身、导入、操练、巩固、作业布置。
四、教学反思
学生参与度较高。`
  assert.equal(looksLikePaper(plan), false, '教案不是试卷')
  assert.equal(detectDocSubject(plan, '三年级英语教案'), 'english', '标题写着英语 → 英语文档')
  const feedback = '家长反馈汇总：孩子最近做作业比较慢，希望老师多关注。电话沟通记录如下，家长都比较配合，整体满意度较高，没有特别的投诉。'
  assert.equal(looksLikePaper(feedback), false)
  assert.equal(detectDocSubject(feedback, '家长反馈'), 'general', '看不出学科 = 通用')
  assert.equal(detectDocSubject(MATH_BODY + ENGLISH_BODY, '混合'), 'general', '混合 = 通用')
}

// ── looksLikePaper ──
{
  for (const t of [MATH, CHINESE, ENGLISH, MATH_BODY, CHINESE_BODY, ENGLISH_BODY]) assert.equal(looksLikePaper(t), true)
  assert.equal(looksLikePaper('期末测试卷\n姓名 班级 得分\n一、选择题（每题 2 分）\n1.（  ）'), true)
  assert.equal(looksLikePaper('', ''), true, '没有文字：当试卷')
  assert.equal(looksLikePaper('会议纪要：本周教研组讨论了下学期的课程安排和听课计划，各位老师分别汇报了教学进度，下周继续跟进。'), false)
  assert.equal(looksLikePaper('本周教研会议纪要，讨论内容如下，请各位老师查收并按时反馈修改意见和后续安排，谢谢配合大家的工作。', '期中复习安排'), true, '标题带「期中」：宁可判成试卷（试卷库里能删）')
}

// ── 内容学科的可见性 ──
assert.equal(asContentSubject(undefined), 'general')
assert.equal(asContentSubject('physics'), 'general')
assert.equal(asContentSubject('math'), 'math')
assert.equal(visibleInSubject('general', 'math'), true)
assert.equal(visibleInSubject(undefined, 'math'), true, '缺省 = 通用')
assert.equal(visibleInSubject('math', 'math'), true)
assert.equal(visibleInSubject('english', 'math'), false)
assert.equal(visibleInSubject('english', undefined), true, '没指定会话学科 = 不过滤')

// ── 表里的科目列 ──
assert.match(subjectColumnNote(['姓名', '科目', '成绩']), /「科目」列/)
assert.match(subjectColumnNote(['学科']), /学科/)
assert.equal(subjectColumnNote(['姓名', '年级', '成绩']), null)

console.log('classify.test ✓')
