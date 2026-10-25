// 两份样本卷（samples/g4-2025.pdf、g4-2026.pdf）的 P1 标准答案，写成接近真实模型会给出的样子：
// 含 underline_lost / kp_uncertain 标记、一个不在树里的知识点代码（应被程序退回最近祖先）、一条 kp_suggestion。
// anchor / anchor_ref 对应 PDF 文本层的 [页-行]（见 tests/mock-ai/dump-pages.cjs 的输出）。
// 按「请求里的页码」切片，所以单批、按页拆批、对半拆小都能得到自洽的响应。

/** 题目简写：q(section, no, qtype, stem, options, kp_main, secondary, difficulty, errReason, anchor, ref, page, score, extra) */
function q(section, no, qtype, stem, options, kp, secondary, difficulty, errReason, anchor, ref, page, score, extra = {}) {
  return {
    no: String(no), section, qtype, material_id: extra.material_id ?? null, stem, options, answer: '', score,
    kp_main: kp, kp_secondary: secondary, kp_suggestion: extra.suggestion ?? '', difficulty,
    error_prone: !!errReason, error_reason: errReason || '', page, anchor, anchor_ref: ref,
    continued_from_prev: false, continues_next: false, flags: extra.flags ?? []
  }
}
const UL = ['underline_lost']

// ───────── g4-2026 ─────────
const sec26 = [
  { no: '一', title: '选出画线部分读音不同的一项', qtype: 'PH_DIFF', score_each: 2, total_score: 10, page: 1 },
  { no: '二', title: '单项选择', qtype: 'MC', score_each: 2, total_score: 20, page: 1 },
  { no: '三', title: '用所给词的适当形式填空', qtype: 'FORM', score_each: 2, total_score: 10, page: 1 },
  { no: '四', title: '补全对话', qtype: 'DIALOG', score_each: 3, total_score: 15, page: 1 },
  { no: '五', title: '阅读短文，选择正确答案', qtype: 'RD_MC', score_each: 3, total_score: 15, page: 2 },
  { no: '六', title: '看图连词成句', qtype: 'ORDER', score_each: 3, total_score: 15, page: 2 },
  { no: '七', title: '书面表达', qtype: 'WRITE', score_each: null, total_score: 15, page: 2 }
]
const mat26 = [
  { key: 'wb', section: '四', kind: 'word_bank', page: 1, text: "A. They're 80 yuan. B. It's sunny and warm. C. Can I help you? D. Size 6, please. E. Are they nice?" },
  { key: 'rd', section: '五', kind: 'passage', page: 2, text: "Hi, I'm Amy. I live in Sydney. In Sydney, it's hot in December. Last Sunday was sunny. I went to the beach with my family. We swam and ate ice cream. My father is taller than me, and he can swim very fast. I think we should protect the sea. Don't throw rubbish on the beach!" }
]
const MC = (a, b, c) => [`A. ${a}`, `B. ${b}`, `C. ${c}`]
const qs26 = [
  q('一', 1, 'PH_DIFF', '', MC('farm', 'car', 'warm'), 'PH.PHONICS.COMBO', [], 3, 'warm 中 ar 读 /ɔː/，与 farm、car 的 /ɑː/ 不同', '1. A. farm B. car', '1-04', 1, 2, { flags: UL }),
  q('一', 2, 'PH_DIFF', '', MC('horse', 'work', 'fork'), 'PH.PHONICS.COMBO', [], 3, 'work 中 or 读 /ɜː/，其余读 /ɔː/', '2. A. horse B. work', '1-05', 1, 2, { flags: UL }),
  q('一', 3, 'PH_DIFF', '', MC('teacher', 'head', 'read'), 'PH.PHONICS.COMBO', [], 3, 'ea 可读 /iː/ 或 /e/，head 的读音与另两个不同', '3. A. teacher B. head', '1-06', 1, 2, { flags: UL }),
  q('一', 4, 'PH_DIFF', '', MC('cow', 'snow', 'how'), 'PH.PHONICS.COMBO', [], 2, '', '4. A. cow B. snow', '1-07', 1, 2, { flags: UL }),
  q('一', 5, 'PH_DIFF', '', MC('bird', 'girl', 'here'), 'PH.PHONICS.COMBO', [], 3, '', '5. A. bird B. girl', '1-08', 1, 2, { flags: UL }),
  q('二', 6, 'MC', 'Is this the computer room? —Yes, ____.', MC('it is', "it isn't", 'they are'), 'GR.SENT.YESNO.BE', ['GR.PRON.DEMO'], 2, '', '6. Is this the computer room?', '1-10', 1, 2),
  q('二', 7, 'MC', "It's 7 o'clock. It's time ____ breakfast.", MC('to', 'for', 'go'), 'GR.PREP.COLLOC', [], 3, 'time for + 名词，time to + 动词', "7. It's 7 o'clock", '1-11', 1, 2),
  q('二', 8, 'MC', 'Are these carrots? —____.', MC('Yes, it is', "No, they aren't", "No, it isn't"), 'GR.SENT.YESNO.BE', ['GR.PRON.DEMO'], 3, 'these 是复数，回答要用 they', '8. Are these carrots?', '1-12', 1, 2),
  q('二', 9, 'MC', 'Tom ____ a big farm.', MC('have', 'has', 'are'), 'GR.VERB.HAVE', [], 2, '主语是第三人称单数，用 has', '9. Tom ______ a big farm.', '1-13', 1, 2),
  q('二', 10, 'MC', "Can I wear my new dress? —Yes, you ____. It's warm.", MC('can', "can't", 'do'), 'GR.VERB.MODAL.CAN', ['FN.DIALOG'], 2, '', '10. Can I wear my new', '1-14', 1, 2),
  q('二', 11, 'MC', 'How much ____ these shoes?', MC('is', 'are', 'am'), 'GR.SENT.WH.HOW', ['FN.SHOP.PRICE'], 2, 'shoes 是复数，be 动词用 are', '11. How much ______ these', '1-15', 1, 2),
  q('二', 12, 'MC', 'My mother is ____ than me.', MC('tall', 'taller', 'tallest'), 'GR.ADJ.COMPARE.REG', [], 3, 'than 前要用比较级', '12. My mother is', '1-16', 1, 2),
  q('二', 13, 'MC', "It's 9:00 p.m. It's time ____ go to bed.", MC('to', 'for', 'of'), 'GR.PREP.COLLOC', [], 3, 'time to + 动词原形', "13. It's 9:00 p.m.", '1-17', 1, 2),
  q('二', 14, 'MC', 'What ____ you do yesterday? —I watched TV.', MC('do', 'did', 'does'), 'GR.TENSE.PAST.AUX', [], 3, 'yesterday 表示过去，助动词用 did', '14. What ______ you do', '1-18', 1, 2),
  q('二', 15, 'MC', "We should ____ water. It's important.", MC('save', 'saves', 'saving'), 'GR.VERB.MODAL.SHOULD', [], 2, '', '15. We should ______', '1-19', 1, 2),
  q('三', 16, 'FORM', 'Look at the ____ (sheep).', [], 'GR.NOUN.PLURAL.IRR', [], 3, 'sheep 单复数同形，易误加 -s', '16. Look at the', '1-21', 1, 2),
  q('三', 17, 'FORM', 'Those are ____ (tomato).', [], 'GR.NOUN.PLURAL.REG', [], 3, 'tomato 的复数加 -es', '17. Those are ______', '1-21', 1, 2),
  q('三', 18, 'FORM', 'My sister ____ (like) music.', [], 'GR.VERB.FORM.THIRD', [], 2, '主语是第三人称单数，动词加 -s', '18. My sister ______', '1-22', 1, 2),
  q('三', 19, 'FORM', "I'm ____ (old) than my brother.", [], 'GR.ADJ.COMPARE.REG', [], 3, '', "19. I'm ______ (old)", '1-22', 1, 2),
  q('三', 20, 'FORM', 'Last weekend, I ____ (play) football with my friends.', [], 'GR.TENSE.PAST.REG', [], 3, '', '20. Last weekend, I', '1-23', 1, 2),
  q('四', 21, 'DIALOG', '—____ —Yes. I want a pair of shoes.', [], 'FN.SHOP', [], 3, '', '21. —______ —Yes. I', '1-27', 1, 3, { material_id: 'wb' }),
  q('四', 22, 'DIALOG', '—What size? —____', [], 'FN.SHOP', [], 2, '', '22. —What size?', '1-27', 1, 3, { material_id: 'wb', suggestion: '购物：尺码询问', flags: ['kp_uncertain'] }),
  q('四', 23, 'DIALOG', '—How much are they? —____', [], 'FN.SHOP.PRICE', [], 2, '', '23. —How much are', '1-28', 1, 3, { material_id: 'wb' }),
  q('四', 24, 'DIALOG', '—____ —Yes, they are.', [], 'GR.SENT.YESNO.BE', ['FN.DIALOG'], 3, '', '24. —______ —Yes,', '1-28', 1, 3, { material_id: 'wb' }),
  q('四', 25, 'DIALOG', "—What's the weather like? —____", [], 'FN.WEATHER', [], 2, '', "25. —What's the", '1-28', 1, 3, { material_id: 'wb' }),
  q('五', 26, 'RD_MC', 'Where does Amy live?', MC('In Beijing', 'In Sydney', 'In London'), 'RD.DETAIL.FACT', [], 1, '', '26. Where does Amy live?', '2-06', 2, 3, { material_id: 'rd' }),
  q('五', 27, 'RD_MC', 'What was the weather like last Sunday?', MC('Rainy', 'Snowy', 'Sunny'), 'RD.DETAIL.FACT', ['VO.TOPIC.WEATHER'], 2, '', '27. What was the weather', '2-07', 2, 3, { material_id: 'rd' }),
  q('五', 28, 'RD_MC', 'What did Amy do last Sunday?', MC('She went to the beach', 'She went to the zoo', 'She stayed at home'), 'RD.DETAIL.FACT', ['GR.TENSE.PAST.IRREG'], 3, '', '28. What did Amy do', '2-08', 2, 3, { material_id: 'rd' }),
  q('五', 29, 'RD_MC', 'Who is taller?', MC('Amy', "Amy's father", "Amy's mother"), 'RD.DETAIL.FACT', ['GR.ADJ.COMPARE.THAN'], 3, '', '29. Who is taller?', '2-10', 2, 3, { material_id: 'rd' }),
  q('五', 30, 'RD_MC', 'What does Amy think?', MC('We should protect the sea', 'We can throw rubbish', "It's cold in December"), 'RD.INFER.OPINION', [], 4, '', '30. What does Amy think?', '2-11', 2, 3, { material_id: 'rd' }),
  q('六', 31, 'ORDER', 'is, the, music, room, on, third, the, floor (.)', [], 'WR.ORDER', ['GR.PREP.PLACE'], 3, '序数词 third 前要加 the', '31. is, the, music, room', '2-14', 2, 3),
  q('六', 32, 'ORDER', 'you, did, what, do, last, weekend (?)', [], 'WR.ORDER', ['GR.TENSE.PAST.AUX'], 3, '', '32. you, did, what', '2-14', 2, 3),
  q('六', 33, 'ORDER', 'are, these, yours (?)', [], 'WR.ORDER', ['GR.PRON.POSS.NOUN'], 2, '', '33. are, these, yours', '2-16', 2, 3),
  q('六', 34, 'ORDER', "taller, I'm, than, Mike (.)", [], 'WR.ORDER', ['GR.ADJ.COMPARE.THAN'], 3, '', "34. taller, I'm, than", '2-16', 2, 3),
  q('六', 35, 'ORDER', 'should, we, trees, plant (.)', [], 'WR.ORDER', ['GR.VERB.MODAL.SHOULD'], 2, '', '35. should, we, trees', '2-16', 2, 3),
  q('七', 36, 'WRITE', '以“My Last Weekend”为题，写一写你上周末做了什么，不少于5句话。（提示：用一般过去时）', [], 'WR.EXPR.PAST', ['GR.TENSE.PAST.IRREG'], 5, '', '36. 以“My Last Weekend”', '2-18', 2, 15)
]

// ───────── g4-2025 ─────────
const sec25 = [
  { no: '一', title: '选出不同类的单词', qtype: 'VO_CLASS', score_each: 2, total_score: 10, page: 1 },
  { no: '二', title: '单项选择', qtype: 'MC', score_each: 2, total_score: 20, page: 1 },
  { no: '三', title: '按要求写单词', qtype: 'FORM', score_each: 2, total_score: 10, page: 1 },
  { no: '四', title: '补全对话', qtype: 'DIALOG', score_each: 3, total_score: 15, page: 1 },
  { no: '五', title: '阅读短文，判断正(T)误(F)', qtype: 'RD_TF', score_each: 3, total_score: 15, page: 2 },
  { no: '六', title: '连词成句', qtype: 'ORDER', score_each: 3, total_score: 15, page: 2 },
  { no: '七', title: '书面表达', qtype: 'WRITE', score_each: null, total_score: 15, page: 2 }
]
const mat25 = [
  { key: 'wb', section: '四', kind: 'word_bank', page: 1, text: "A. They're $15. B. Yes, it is. C. What's the weather like? D. Can I help you? E. Are these yours?" },
  { key: 'rd', section: '五', kind: 'passage', page: 2, text: "Hello, I'm Mike. Look at our school. This is the library. It's on the second floor. My classroom is on the first floor. It's 11:45 now. It's time for lunch. After lunch, we have music class. I like music." }
]
const qs25 = [
  q('一', 1, 'VO_CLASS', '', MC('sunny', 'windy', 'weather'), 'VO.FORM.CLASSIFY', ['VO.TOPIC.WEATHER'], 2, 'weather 是名词，另两个是形容词', '1. A. sunny B. windy', '1-04', 1, 2),
  q('一', 2, 'VO_CLASS', '', MC('sheep', 'hen', 'farm'), 'VO.FORM.CLASSIFY', ['VO.TOPIC.ANIMAL'], 2, '', '2. A. sheep B. hen', '1-05', 1, 2),
  q('一', 3, 'VO_CLASS', '', MC('skirt', 'dress', 'cold'), 'VO.FORM.CLASSIFY', ['VO.TOPIC.CLOTHES'], 2, '', '3. A. skirt B. dress', '1-06', 1, 2),
  q('一', 4, 'VO_CLASS', '', MC('library', "teachers' office", 'lunch'), 'VO.FORM.CLASSIFY', ['VO.TOPIC.SCHOOL'], 2, '', '4. A. library B. teachers', '1-07', 1, 2),
  q('一', 5, 'VO_CLASS', '', MC('tomato', 'potatoes', 'carrots'), 'VO.FORM.CLASSIFY', ['GR.NOUN.PLURAL.REG'], 3, 'tomato 是单数，另两个是复数', '5. A. tomato B. potatoes', '1-08', 1, 2),
  q('二', 6, 'MC', 'Is this the art room? —No, ____.', MC('it is', "it isn't", "they aren't"), 'GR.SENT.YESNO.BE', [], 2, '', '6. Is this the art room?', '1-10', 1, 2),
  q('二', 7, 'MC', "What time is it? —It's 9 o'clock. It's time ____ English class.", MC('to', 'for', 'go'), 'GR.PREP.COLLOC', ['FN.TIME'], 3, 'time for + 名词，time to + 动词', '7. What time is it?', '1-11', 1, 2),
  q('二', 8, 'MC', '____ are these? —They\'re carrots.', MC('What', 'Who', 'How'), 'GR.SENT.WH.WHAT', [], 2, '', '8. ______ are these?', '1-12', 1, 2),
  q('二', 9, 'MC', 'These ____ my pants.', MC('is', 'am', 'are'), 'GR.VERB.BE', [], 2, '', '9. These ______ my pants.', '1-13', 1, 2),
  q('二', 10, 'MC', "Can I wear my T-shirt today? —No, you ____. It's cold.", MC('can', "can't", "don't"), 'GR.VERB.MODAL.CAN', [], 2, '', '10. Can I wear my T-shirt', '1-14', 1, 2),
  q('二', 11, 'MC', 'How much ____ this skirt?', MC('is', 'are', 'be'), 'GR.SENT.WH.HOW', ['FN.SHOP.PRICE'], 2, 'this skirt 是单数，用 is', '11. How much ______ this', '1-15', 1, 2),
  q('二', 12, 'MC', 'Look at the sheep. ____ are so big!', MC('It', 'They', 'This'), 'GR.PRON.PERSONAL', ['GR.NOUN.PLURAL.IRR'], 3, 'sheep 单复数同形，这里指多只，代词用 they', '12. Look at the sheep.', '1-16', 1, 2),
  q('二', 13, 'MC', "It's 6:30. It's time ____ get up.", MC('to', 'for', 'at'), 'GR.PREP.COLLOC', [], 3, 'time to + 动词原形', "13. It's 6:30. It's time", '1-17', 1, 2),
  q('二', 14, 'MC', "Where are my shoes? —They're ____ the bed.", MC('in', 'under', 'at'), 'GR.PREP.PLACE', [], 2, '', '14. Where are my shoes?', '1-18', 1, 2),
  q('二', 15, 'MC', "What's the weather like in Beijing? —It's ____.", MC('rainy', 'rain', 'rains'), 'FN.WEATHER', ['VO.TOPIC.WEATHER'], 2, 'It\'s 后面要用形容词 rainy', "15. What's the weather like", '1-19', 1, 2),
  q('三', 16, 'FORM', 'tomato（复数）____', [], 'GR.NOUN.PLURAL.REG', [], 2, 'tomato 的复数加 -es', '16. tomato（复数）', '1-21', 1, 2),
  q('三', 17, 'FORM', 'sheep（复数）____', [], 'GR.NOUN.PLURAL.IRR', [], 3, 'sheep 单复数同形', '17. sheep（复数）', '1-21', 1, 2),
  q('三', 18, 'FORM', 'this（复数）____', [], 'GR.PRON.DEMO', [], 2, '', '18. this（复数）', '1-21', 1, 2),
  q('三', 19, 'FORM', 'hot（反义词）____', [], 'VO.FORM.OPPOSITE', [], 1, '', '19. hot（反', '1-21', 1, 2),
  q('三', 20, 'FORM', 'can not（缩写）____', [], 'VO.FORM.ABBREV', [], 2, "can not 的缩写是 can't", '20. can not（缩写）', '1-22', 1, 2),
  q('四', 21, 'DIALOG', '—____ —Yes. I want a pair of shoes.', [], 'FN.SHOP', [], 3, '', '21. —______ —Yes. I', '1-26', 1, 3, { material_id: 'wb' }),
  q('四', 22, 'DIALOG', '—How much are these shoes? —____', [], 'FN.SHOP.PRICE', [], 2, '', '22. —How much are these', '1-26', 1, 3, { material_id: 'wb' }),
  q('四', 23, 'DIALOG', "—____ —It's cool in Lhasa.", [], 'FN.WEATHER', [], 2, '', '23. —______ —It', '1-28', 1, 3, { material_id: 'wb' }),
  q('四', 24, 'DIALOG', '—Is it cold? —____', [], 'GR.SENT.YESNO.BE', [], 2, '', '24. —Is it cold?', '1-28', 1, 3, { material_id: 'wb' }),
  q('四', 25, 'DIALOG', "—____ —No, they aren't.", [], 'GR.SENT.YESNO.BE', ['GR.PRON.DEMO'], 3, '', '25. —______ —No,', '1-28', 1, 3, { material_id: 'wb' }),
  q('五', 26, 'RD_TF', 'The library is on the first floor.', [], 'RD.DETAIL.TF', [], 2, '', '26. The library is on', '2-05', 2, 3, { material_id: 'rd' }),
  q('五', 27, 'RD_TF', "Mike's classroom is on the first floor.", [], 'RD.DETAIL.TF', [], 2, '', "27. Mike's classroom is", '2-05', 2, 3, { material_id: 'rd' }),
  q('五', 28, 'RD_TF', "It's time for English class.", [], 'RD.DETAIL.TF', [], 2, '', "28. It's time for English", '2-06', 2, 3, { material_id: 'rd' }),
  q('五', 29, 'RD_TF', 'They have music class after lunch.', [], 'RD.DETAIL.TF', [], 2, '', '29. They have music class', '2-06', 2, 3, { material_id: 'rd' }),
  q('五', 30, 'RD_TF', 'Mike likes music.', [], 'RD.DETAIL.TF', [], 1, '', '30. Mike likes', '2-06', 2, 3, { material_id: 'rd' }),
  q('六', 31, 'ORDER', 'is, the, on, second, floor, library (.)', [], 'WR.ORDER', ['GR.PREP.PLACE'], 3, '', '31. is, the, on, second', '2-09', 2, 3),
  q('六', 32, 'ORDER', "time, it's, to, go, to, school (.)", [], 'WR.ORDER', ['GR.PREP.COLLOC'], 3, '', "32. time, it's, to", '2-09', 2, 3),
  q('六', 33, 'ORDER', 'are, these, what (?)', [], 'WR.ORDER', ['GR.SENT.WH.WHAT'], 2, '', '33. are, these, what', '2-10', 2, 3),
  q('六', 34, 'ORDER', 'cold, it, is, in, Harbin (?)', [], 'WR.ORDER', ['GR.SENT.YESNO.BE'], 3, '', '34. cold, it, is', '2-10', 2, 3),
  q('六', 35, 'ORDER', 'much, how, is, this, dress (?)', [], 'WR.ORDER', ['GR.SENT.WH.HOW'], 3, '', '35. much, how, is', '2-10', 2, 3),
  q('七', 36, 'WRITE', '以“My Day”为题，写一写你一天的时间安排，不少于5句话。', [], 'WR.EXPR.PRESENT', ['FN.TIME'], 4, '', '36. 以“My Day”', '2-13', 2, 15)
]

const PAPERS = {
  'g4-2026': {
    meta: { title: '2025-2026学年第二学期四年级英语期末试卷', grade: 4, semester: '下', school_year: '2025-2026', exam_type: '期末', textbook: '人教PEP版', total_score: 100 },
    sections: sec26, materials: mat26, questions: qs26, pageCount: 2
  },
  'g4-2025': {
    meta: { title: '2024-2025学年第二学期四年级英语期末试卷', grade: 4, semester: '下', school_year: '2024-2025', exam_type: '期末', textbook: '人教PEP版', total_score: 100 },
    sections: sec25, materials: mat25, questions: qs25, pageCount: 2
  }
}

/** g4-2025.pdf 第 1 页的行几何（取自 PDF 文本层，供视觉版 canned 响应折算 bbox） */
const ROWS_2025_P1 = [
  ['1-03', '一、选出不同类的单词。（每题2分，共10分）', 0.114, 0.150, 0.388], ['1-04', '1. A. sunny B. windy C. weather', 0.132, 0.180, 0.279],
  ['1-05', '2. A. sheep B. hen C. farm', 0.132, 0.207, 0.235], ['1-06', '3. A. skirt B. dress C. cold', 0.132, 0.236, 0.234],
  ['1-07', "4. A. library B. teachers' office C. lunch", 0.132, 0.263, 0.352], ['1-08', '5. A. tomato B. potatoes C. carrots', 0.132, 0.291, 0.314],
  ['1-10', "6. Is this the art room? —No, ______. A. it is B. it isn't C. they aren't", 0.132, 0.362, 0.606],
  ['1-11', "7. What time is it? —It's 9 o'clock. It's time ______ English class. A. to B. for C. go", 0.132, 0.389, 0.736],
  ['1-12', "8. ______ are these? —They're carrots. A. What B. Who C. How", 0.132, 0.417, 0.563], ['1-13', '9. These ______ my pants. A. is B. am C. are', 0.132, 0.444, 0.396],
  ['1-14', "10. Can I wear my T-shirt today? —No, you ______. It's cold. A. can B. can't C. don't", 0.132, 0.473, 0.752],
  ['1-15', '11. How much ______ this skirt? A. is B. are C. be', 0.132, 0.500, 0.437], ['1-16', '12. Look at the sheep. ______ are so big! A. It B. They C. This', 0.132, 0.527, 0.548],
  ['1-17', "13. It's 6:30. It's time ______ get up. A. to B. for C. at", 0.132, 0.555, 0.473], ['1-18', "14. Where are my shoes? —They're ______ the bed. A. in B. under C. at", 0.132, 0.583, 0.633],
  ['1-19', "15. What's the weather like in Beijing? —It's ______. A. rainy B. rain C. rains", 0.132, 0.611, 0.674],
  ['1-21', '16. tomato（复数）______ 17. sheep（复数）______ 18. this（复数）______ 19. hot（反', 0.132, 0.681, 0.752],
  ['1-22', '义词）______ 20. can not（缩写）______', 0.132, 0.706, 0.353],
  ['1-26', '21. —______ —Yes. I want a pair of shoes. 22. —How much are these shoes? —', 0.132, 0.846, 0.712],
  ['1-28', "23. —______ —It's cool in Lhasa. 24. —Is it cold? —______ 25. —______ —No, they", 0.132, 0.898, 0.738]
]

function norm(s) { return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '') }

/** 视觉版：把文本锚点折算成模型会给的 [x,y,w,h]（带一点确定性的抖动，像真实模型的估计） */
function visionAnchor(anchor, ref, no) {
  const row = ROWS_2025_P1.find(r => r[0] === ref)
  if (!row) return null
  const [, text, x, y, w] = row
  const at = norm(text).indexOf(norm(anchor))
  const frac = at < 0 ? 0 : at / norm(text).length
  const jitter = (k) => Math.round(Math.sin(Number(no) * 12.9898 + k) * 0.004 * 1000) / 1000
  const bx = Math.min(0.95, x + w * frac + jitter(1))
  const bw = Math.min(0.97 - bx, Math.max(0.12, w * 0.55))
  return [Math.max(0, +bx.toFixed(3)), +(y + jitter(2)).toFixed(3), +bw.toFixed(3), 0.022]
}

/**
 * 生成一次响应。
 * opts: { file, mode, pages:[…], prefix:'b1', splitLast: bool, userText }
 * splitLast：模拟「一道题被页/批边界切开」——前一批的最后一题只有前半（continues_next），后一批开头续写完整记录。
 */
function build({ file, mode, pages, prefix, splitLast, visionFile, quirks = {} }) {
  // 文件名以样本名开头就算同一份（测试里会造 g4-2026-copy.pdf 这样的副本以绕开「重复导入」）
  const name = visionFile || file.replace(/\.[^.]+$/, '')
  const key = name.startsWith('g4-2025-page1') ? 'g4-2025-page1' : Object.keys(PAPERS).find(k => name.startsWith(k))
  const base = key === 'g4-2025-page1' ? PAPERS['g4-2025'] : PAPERS[key]
  if (!base) return null
  const vis = mode === 'vision'
  const inPages = (p) => pages.includes(p)
  const mats = base.materials.filter(m => inPages(m.page))
  const idOf = (key2) => `${prefix}-m${mats.findIndex(m => m.key === key2) + 1}`

  let questions = base.questions.filter(x => inPages(x.page)).map(x => {
    const out = { ...x, flags: [...x.flags] }
    out.material_id = x.material_id ? idOf(x.material_id) : null
    if (vis) {
      out.anchor = visionAnchor(x.anchor, x.anchor_ref, x.no)
      delete out.anchor_ref
      out.flags = out.flags.filter(f => f !== 'underline_lost')
      if (!out.anchor) out.flags.push('bbox_uncertain')
    }
    return out
  })
  // 视觉版题目含 <u> 标签的画线信息（只有 2026 的语音题；2025 的第一大题是分类题）
  if (vis && base === PAPERS['g4-2026']) {
    const ul = { 1: ['f<u>ar</u>m', 'c<u>ar</u>', 'w<u>ar</u>m'], 2: ['h<u>or</u>se', 'w<u>or</u>k', 'f<u>or</u>k'], 3: ['t<u>ea</u>cher', 'h<u>ea</u>d', 'r<u>ea</u>d'], 4: ['c<u>ow</u>', 'sn<u>ow</u>', 'h<u>ow</u>'], 5: ['b<u>ir</u>d', 'g<u>ir</u>l', 'h<u>er</u>e'] }
    questions.forEach(x => { if (x.section === '一' && ul[x.no]) x.options = ul[x.no].map((w, i) => `${'ABC'[i]}. ${w}`) })
  }

  if (splitLast) {
    // 以 2026 第 25 题（页 1 末尾）为切口
    const cut = base.questions.find(x => x.no === '25')
    if (inPages(cut.page)) {
      if (pages.length === 1 || Math.max(...pages) === cut.page) {
        const i = questions.findIndex(x => x.no === '25')
        if (i >= 0) questions[i] = { ...questions[i], stem: "—What's the", continues_next: true, flags: [...questions[i].flags, 'stem_incomplete'] }
      }
    } else if (pages[0] === cut.page + 1) {
      // 材料 id 沿用上一批给出的（第一批前缀固定是 b1，词库是该批第一份材料）
      const full = { ...cut, flags: [], material_id: 'b1-m1', continued_from_prev: !quirks.noFlag }
      if (vis) { full.anchor = visionAnchor(cut.anchor, cut.anchor_ref, cut.no); delete full.anchor_ref }
      if (!quirks.dropContinued) questions = [full, ...questions]
    }
  }

  // 真实模型会犯的错：anchor 里夹 OCR 式错字（保留题号让它仍可定位）、页码写错
  if (quirks.typo) {
    questions = questions.map(x => {
      if (typeof x.anchor !== 'string' || x.anchor.length < 12) return x
      const i = Math.floor(x.anchor.length * 0.7)
      return { ...x, anchor: x.anchor.slice(0, i) + (x.anchor[i] === 'e' ? 'c' : 'x') + x.anchor.slice(i + 1) }
    })
  }
  if (quirks.badPage) questions = questions.map(x => ({ ...x, page: x.page + 7 }))

  const sections = base.sections.filter(s => inPages(s.page)).map(s => ({
    no: s.no, title: s.title, qtype: s.qtype, score_each: s.score_each, total_score: s.total_score, continued_from_prev: false
  }))
  if (splitLast && pages[0] === 2) {
    // 批次开头是上一大题的中间部分时，按提示词约定补一条续写的大题
    const s = base.sections.find(x => x.no === '四')
    sections.unshift({ no: s.no, title: s.title, qtype: s.qtype, score_each: s.score_each, total_score: s.total_score, continued_from_prev: !quirks.noFlag })
  }
  const materials = mats.map(m => ({
    id: idOf(m.key), section: m.section, kind: m.kind, text: m.text, page: m.page, continued_from_prev: false, continues_next: false
  }))
  const firstBatch = pages[0] === 1
  return {
    meta: firstBatch ? base.meta : { title: null, grade: null, semester: null, school_year: null, exam_type: null, textbook: null, total_score: null },
    sections, materials, questions, notes: []
  }
}

module.exports = { build, PAPERS }
