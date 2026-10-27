/**
 * 设计样张用的数据：知识点来自两份真实的四年级期末卷（2024–2025、2025–2026）的分析结果，
 * 原卷截图来自 docs/体验报告/产出/tutor-考情分析报告/（真实 PNG）。
 * 考过几份、分值占比取自该报告；「物主代词」「拇指索引的词条数」是示意数字。
 */
import type { EntryProps } from './Entry'
import type { CategoryKey } from './tokens'
import q09 from './assets/gallery-q09.png?inline'
import q16 from './assets/gallery-q16.png?inline'
import r001 from './assets/real-q-001.png?inline'
import r002 from './assets/real-q-002.png?inline'
import r003 from './assets/real-q-003.png?inline'
import r004 from './assets/real-q-004.png?inline'
import r007 from './assets/real-q-007.png?inline'
import r009 from './assets/real-q-009.png?inline'
import r010 from './assets/real-q-010.png?inline'
import r013 from './assets/real-q-013.png?inline'
import r014 from './assets/real-q-014.png?inline'

export const P25 = '四年级 2024–2025 期末'
export const P26 = '四年级 2025–2026 期末'

export const E_PLURAL: EntryProps = {
  term: '名词复数', examples: ['books', 'boxes', 'children'], category: 'grammar',
  tags: [
    { label: '考过 2/2 份', hint: '这 2 份四年级期末卷里，2 份都考到了名词复数。' },
    { label: '约 8 分', hint: '这个考点在两份卷子里各占约 4% 的分值，折合约 8 分（总分 200 分）。' },
    { label: '易错', kind: 'mistake', hint: 'AI 估计其中 6 道题学生容易做错（是估计，不是真实成绩）：tomato 要加 es，sheep 单复数一样。' }
  ],
  plain: '一个变成两个以上时，名词要变形：多数加 s，以 s、x、o 结尾的加 es，少数不规则（child → children）。',
  examplesSentences: [
    { en: 'Those are tomato**es**.', zh: '那些是西红柿。' },
    { en: 'Look at the **sheep**. They are so big!', zh: '看那些羊，它们好大！' }
  ],
  sources: [{ src: r001, paper: P26, question: '16' }, { src: r002, paper: P26, question: '17' }],
  see: [{ term: '可数与不可数名词' }, { term: '不规则复数' }]
}
export const E_TIME: EntryProps = {
  term: 'time for / time to', examples: ['time for breakfast', 'time to get up'], category: 'grammar',
  tags: [
    { label: '考过 2/2 份', hint: '这 2 份四年级期末卷都考到了。' },
    { label: '约 8 分', hint: '两份卷子里各占约 4% 的分值，折合约 8 分（总分 200 分）。' },
    { label: '易错', kind: 'mistake', hint: 'AI 估计其中 4 道题学生容易做错：for 和 to 很容易混。' }
  ],
  plain: '「该做某事了」。time for 后面跟名词，time to 后面跟动词原形。',
  examplesSentences: [
    { en: "It's time **for** breakfast.", zh: '该吃早饭了。' },
    { en: "It's time **to** go to bed.", zh: '该睡觉了。' }
  ],
  sources: [{ src: r003, paper: P26, question: '7' }, { src: r004, paper: P26, question: '13' }],
  see: [{ term: 'be 动词一般疑问句' }]
}
export const E_POSS: EntryProps = {
  term: '物主代词', examples: ['my', 'your', 'his'], category: 'grammar',
  tags: [
    { label: '考过 1/2 份', hint: '这 2 份卷子里，只有 1 份考到（示意数字）。' },
    { label: '约 2 分', hint: '这个考点大约占 2 分（示意数字）。' }
  ],
  plain: '表示「谁的」：my 我的、your 你的、his 他的。后面一定要跟名词。',
  examplesSentences: [{ en: 'These are **my** pants.', zh: '这些是我的裤子。' }],
  sources: [{ src: q09, paper: P25, question: '9' }],
  see: [{ term: '人称代词' }]
}
export const E_YESNO: EntryProps = {
  term: '一般疑问句与简略回答', examples: ['Are these …? — Yes, they are.'], category: 'grammar',
  tags: [{ label: '考过 2/2 份', hint: '这 2 份卷子都考到了。' }, { label: '易错', kind: 'mistake', hint: 'these 是复数，回答要用 they，不能用 it。' }],
  plain: '用 Is / Are / Can 开头问「是不是、能不能」，回答只说 Yes 或 No 再加一个简短的句子。',
  examplesSentences: [{ en: 'Are these carrots? — Yes, **they** are.', zh: '这些是胡萝卜吗？——是的。' }],
  sources: [{ src: r014, paper: P26, question: '8' }]
}
export const E_EA: EntryProps = {
  term: 'ea 字母组合发音', examples: ['eat /iːt/', 'head /hed/'], category: 'phonics',
  tags: [
    { label: '今年新考', kind: 'new', hint: '2024–2025 那份没出现，2025–2026 这份第一次考。' },
    { label: '样本不足', kind: 'thin', hint: '参考的试卷不到 5 份，现在看到的规律可能只是巧合，先不要当趋势。' }
  ],
  plain: '字母组合 ea 有两种常见读法：多数读 /iː/（eat），少数读 /e/（head）。',
  examplesSentences: [{ en: 'T**ea**cher — h**ea**d — r**ea**d', zh: '三个词里，head 的读音不同。' }],
  sources: [{ src: r007, paper: P26, question: '3' }]
}
export const E_SHOP: EntryProps = {
  term: '购物用语', examples: ['How much …?'], category: 'communication',
  tags: [
    { label: '考过 2/2 份', hint: '这 2 份卷子都考到了。' },
    { label: '易错', kind: 'mistake', hint: 'shoes 是复数，be 动词要用 are；this skirt 是单数，用 is。' }
  ],
  plain: '买东西时问「多少钱」和回答价格的固定说法。问句里的 be 动词要和后面的东西一致。',
  examplesSentences: [{ en: 'How much **are** these shoes?', zh: '这双鞋多少钱？' }, { en: 'How much **is** this skirt?', zh: '这条裙子多少钱？' }],
  sources: [{ src: r009, paper: P26, question: '11' }, { src: r010, paper: P25, question: '11' }]
}
export const E_ORDER: EntryProps = {
  term: '连词成句', examples: ['is · the · music · room · on · the · third · floor'], category: 'writing',
  tags: [
    { label: '考过 2/2 份', hint: '这 2 份卷子都考到了。' },
    { label: '约 30 分', hint: '连词成句在两份卷子里合计约占 15% 的分值，折合约 30 分（总分 200 分）。' }
  ],
  plain: '把打乱的词排成一句通顺的话：先找主语和动词，句首字母大写，句末加标点。',
  examplesSentences: [{ en: 'The music room is on **the** third floor.', zh: '音乐教室在三楼。' }],
  sources: [{ src: r013, paper: P26, question: '31' }]
}
export const E_OPPOSITE: EntryProps = {
  term: '反义词', examples: ['hot – cold', 'big – small'], category: 'vocab',
  tags: [{ label: '考过 2/2 份', hint: '这 2 份卷子都考到了。' }],
  plain: '意思正好相反的一对词。',
  examplesSentences: [{ en: 'It is **hot** today, not **cold**.', zh: '今天很热，不冷。' }],
  sources: [{ src: q16, paper: P25, question: '19', tall: true }]
}
export const E_ABBR: EntryProps = {
  term: '缩略形式', examples: ["can not → can't", "it is → it's"], category: 'vocab',
  tags: [{ label: '考过 1/2 份', hint: '这 2 份卷子里有 1 份考到。' }],
  plain: '把两个词合成一个，中间用撇号「\'」代替省掉的字母。',
  examplesSentences: [{ en: "I **can't** wear my T-shirt today.", zh: '我今天不能穿 T 恤。' }]
}
export const E_READ: EntryProps = {
  term: '阅读理解：找细节', examples: ['Who · When · Where'], category: 'reading',
  tags: [{ label: '考过 2/2 份', hint: '这 2 份卷子都考到了。' }],
  plain: '题目问人物、时间、地点这类具体信息，答案就写在短文里，找到对应那一句就行。'
}

/** 总览首屏「最该关注」的 6 个词条 */
export const TOP_ENTRIES: EntryProps[] = [E_PLURAL, E_TIME, E_POSS, E_EA, E_SHOP, E_ORDER]

export const BY_CATEGORY: Record<CategoryKey, EntryProps[]> = {
  phonics: [E_EA],
  vocab: [E_OPPOSITE, E_ABBR],
  grammar: [E_PLURAL, E_TIME, E_POSS, E_YESNO],
  communication: [E_SHOP],
  reading: [E_READ],
  writing: [E_ORDER]
}
/** 各大类的考点数（示意） */
export const COUNTS: Record<CategoryKey, number> = { phonics: 4, vocab: 9, grammar: 14, communication: 5, reading: 3, writing: 2 }
