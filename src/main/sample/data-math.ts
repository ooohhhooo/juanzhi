/**
 * 示例数据：合成的小学数学卷子（3–6 年级，题目是编写的演示题，不是任何真实学校的试卷）。
 * 8 份 = 三年级上期中 / 下期末（2024 学年）+ 四年级 4 份（2024、2025 两个学年 × 期中 + 期末，同比用）+ 五年级 1 份 + 六年级 1 份。
 * 口算「直接写得数」整页算一道题；几何、统计图题带 needs_image 标记（题干里的 [图] 表示这里原卷有插图）。
 * 纯数据，知识点与题型代码取自内置数学种子（taxonomy-math.ts）。
 */
import type { SamplePaper, SampleQ } from './data.ts'

const q = (qtype: string, kp: string, score: number, diff: number, stem: string, options: string[] = [], answer = '', err = '', sec: string[] = [], flags: string[] = []): SampleQ =>
  ({ qtype, kp, score, diff, stem, options, answer, err: err || undefined, sec, flags })
const IMG = ['needs_image']

export const MATH_POOL: Record<string, SampleQ> = {
  // ── 口算 / 笔算 / 脱式 ──
  maOral3: q('MA_ORAL', 'MA.CALC.MUL.ONE_DIGIT', 8, 1, '直接写得数。 24×3=   40×5=   81÷9=   600÷3=   7×8=   3/8+2/8=   1-3/5=   120+80=', [], '72 200 9 200 56 5/8 2/5 200', '', ['MA.CALC.FRAC.ADDSUB_SAME']),
  maOral4: q('MA_ORAL', 'MA.CALC.MUL.MULTI_DIGIT', 8, 2, '直接写得数。 25×4=   125×8=   480÷60=   300×20=   0.5+0.7=   1-0.3=   3.6-1.2=   400÷25=', [], '100 1000 8 6000 1.2 0.7 2.4 16', '末尾有 0 的乘法，积后面的 0 容易少写', ['MA.CALC.DEC.ADDSUB']),
  maOral5: q('MA_ORAL', 'MA.CALC.DEC.MUL', 8, 2, '直接写得数。 0.25×4=   1.2÷0.3=   3.6×0.5=   0.8×0.8=   5.4÷6=   7.5-2.5=   1/2+1/3=   3/4-1/4=', [], '1 4 1.8 0.64 0.9 5 5/6 1/2', '小数乘法积的小数点容易点错位置', ['MA.CALC.FRAC.ADDSUB']),
  maOral6: q('MA_ORAL', 'MA.CALC.FRAC.MUL', 8, 2, '直接写得数。 3/4×8=   2/3÷4=   5/6×3/5=   1÷1/4=   7/8-3/8=   1/2×2/3=   40%×25=   0.75=（  ）/4', [], '6 1/6 1/2 4 1/2 1/3 10 3', '分数除法忘了先变成乘它的倒数', ['MA.NUM.PCT.CONVERT']),
  maVert3: q('MA_VERTICAL', 'MA.CALC.MUL.ONE_DIGIT', 6, 2, '用竖式计算。 306×4=   725÷5=★（带★的要验算）', [], '1224 145', '被乘数中间有 0 时，0 乘出来的进位容易漏加'),
  maVert3b: q('MA_VERTICAL', 'MA.CALC.DEC.ADDSUB', 6, 2, '用竖式计算。 12.5+8.76=   20-7.35=', [], '21.26 12.65', '小数点没有对齐；整数减小数要先补 0'),
  maVert4: q('MA_VERTICAL', 'MA.CALC.DIV.TWO_DIGIT', 6, 3, '用竖式计算。 756÷36=   208÷32=★（带★的要验算）', [], '21 6……16', '试商偏大偏小后忘了调整，余数写得比除数大'),
  maVert5: q('MA_VERTICAL', 'MA.CALC.DEC.DIV', 6, 3, '用竖式计算。 7.28÷0.56=   15.6÷0.4=（得数保留两位小数时写出过程）', [], '13 39', '除数是小数时，除数和被除数的小数点要同时移位'),
  maStep4: q('MA_STEP', 'MA.CALC.MIX.ORDER', 6, 3, '脱式计算。 480-(125+75)×2   (360-120)÷6+18×5', [], '80 130', '有括号先算括号里的，容易按从左到右直接算'),
  maSimple4: q('MA_SIMPLE', 'MA.CALC.MIX.SIMPLE', 6, 4, '能简便的要简便计算。 125×32×25   99×37+37', [], '100000 3700', '用分配律拆数后，漏乘或多加了一项'),
  maLaw4: q('MA_FILL', 'MA.CALC.MIX.LAW', 4, 3, '在（  ）里填上合适的数。 25×(8+4)=25×（  ）+25×（  ）；36+47+64=36+（  ）+47', [], '8 4 64', '乘法分配律只分给括号里的两个数，容易漏掉一个'),
  maEq5: q('MA_EQUATION', 'MA.ALG.EQ.SOLVE', 6, 3, '解方程。 3x+5=20   x÷4-1.5=2.5', [], 'x=5 x=16', '等式两边要同时加减同一个数，容易只改一边'),
  maStepFrac5: q('MA_STEP', 'MA.CALC.FRAC.ADDSUB', 6, 3, '计算，能简算的要简算。 3/4-1/6+5/12   1-(2/5+1/3)', [], '1  4/15', '异分母分数要先通分再加减'),
  maStepFrac6: q('MA_STEP', 'MA.CALC.FRAC.DIV', 6, 3, '计算，能简算的要简算。 5/6×(3/5+3/10)   7/8÷7/16×3/4', [], '3/4  3/2', '除以一个数要乘它的倒数，容易把被除数倒过来'),
  // ── 概念 / 填空 / 判断 / 选择 / 单位 ──
  maDecMean3: q('MA_FILL', 'MA.NUM.DEC.MEANING', 4, 2, '0.35 读作（     ）；6 角=（  ）元；3 元 5 角=（  ）元。', [], '零点三五 0.6 3.5', '小数的读法：小数部分要一位一位地读'),
  maPattern3: q('MA_FILL', 'MA.ALG.PATTERN.NUM', 2, 2, '找规律，填一填。 3，6，12，24，（   ），（   ）。', [], '48 96', ''),
  maJudge3: q('MA_JUDGE', 'MA.NUM.FRAC.MEANING', 2, 2, '把一个蛋糕分成 3 份，每份是它的 1/3。（  ）', [], '×', '必须平均分，才能用分数表示'),
  maShape3: q('MA_JUDGE', 'MA.GEO.SHAPE.QUAD', 2, 1, '长方形和正方形都是四边形。（  ）', [], '√'),
  maUnitTime3: q('MA_UNIT', 'MA.MEAS.TIME.UNIT', 4, 2, '在（  ）里填合适的数。 2 时 15 分=（  ）分；小明 8:50 出发，9:35 到达，路上用了（  ）分钟。', [], '135 45', '求经过的时间，要先算到整点再加剩下的'),
  maUnitMass3: q('MA_UNIT', 'MA.MEAS.UNIT.MASS', 4, 2, '3 千克 500 克=（  ）克；2 吨=（  ）千克；一个鸡蛋约重 50（  ）。', [], '3500 2000 克'),
  maCalendar3: q('MA_FILL', 'MA.MEAS.TIME.CALENDAR', 3, 2, '2024 年 2 月有（  ）天；一年中有（  ）个大月。', [], '29 7', '先判断平年还是闰年，再数天数'),
  maUnitArea3: q('MA_UNIT', 'MA.MEAS.UNIT.AREA', 4, 3, '3.5 m²=（  ）dm²；4 公顷=（  ）m²。', [], '350 40000', '1 m²=100 dm²，容易和长度单位的进率 10 混淆'),
  maLarge4: q('MA_FILL', 'MA.NUM.INT.LARGE', 4, 4, '一个数由 3 个亿、5 个万和 8 个千组成，这个数写作（        ），读作（        ）。', [], '300058000 三亿零五万八千', '中间没有的数位要用 0 占位，容易少写一个 0'),
  maApprox4: q('MA_FILL', 'MA.NUM.INT.APPROX', 3, 3, '把 4087000 改写成用「万」作单位的数是（  ）万；省略万位后面的尾数，约是（  ）万。', [], '408.7 409', '改写和省略尾数是两回事，改写后大小不变'),
  maShift4: q('MA_FILL', 'MA.NUM.DEC.SHIFT', 4, 3, '把 0.56 的小数点向右移动两位是（  ）；4.07 缩小到原来的 1/100 是（  ）。', [], '56 0.0407', '小数点移动的位数和扩大缩小的倍数对不上'),
  maDecProp4: q('MA_CHOICE', 'MA.NUM.DEC.PROP', 2, 2, '下面各数中，与 0.5 大小相等的是（  ）。', ['A. 0.05', 'B. 0.50', 'C. 5.0', 'D. 0.055'], 'B'),
  maTri4: q('MA_FILL', 'MA.GEO.SHAPE.TRIANGLE', 3, 3, '一个三角形的两个内角分别是 45° 和 65°，第三个角是（  ）°，这是一个（     ）三角形。', [], '70 锐角', '三角形的内角和是 180°，别用 360° 算'),
  maChoiceFactor5: q('MA_CHOICE', 'MA.NUM.FACTOR.RULE', 2, 3, '下面各数中，同时是 2、3、5 的倍数的是（  ）。', ['A. 105', 'B. 120', 'C. 132', 'D. 250'], 'B', '要同时满足个位是 0 和各位数字之和是 3 的倍数'),
  maSimplify5: q('MA_FILL', 'MA.NUM.FRAC.SIMPLIFY', 4, 3, '把 18/24 约分是（    ）；把 2/3 和 3/4 通分是（    ）和（    ）。', [], '3/4 8/12 9/12', '约分要约到不能再约，通分的分母要一致'),
  maLetter5: q('MA_FILL', 'MA.ALG.LETTER.EVAL', 4, 3, '当 a=5，b=3 时，2a+b=（  ），a²=（  ）。', [], '13 25', 'a² 表示 a×a，容易当成 a×2'),
  maLetterExpr5: q('MA_FILL', 'MA.ALG.LETTER.EXPR', 3, 3, '小红今年 a 岁，妈妈比她大 28 岁，妈妈今年（     ）岁；3 年后妈妈（     ）岁。', [], 'a+28 a+31'),
  maNeg6: q('MA_FILL', 'MA.NUM.NEG', 3, 2, '零下 5 ℃ 记作（  ）℃；比 -3 ℃ 低 4 ℃ 的温度是（  ）℃。', [], '-5 -7', '负数在数轴上越往左越小，往低数的时候要往左数'),
  maPct6: q('MA_FILL', 'MA.NUM.PCT.CONVERT', 4, 3, '0.35=（  ）%=（  ）/20；3/8=（  ）%。', [], '35 7 37.5', '分数化成百分数要先化成小数'),
  maRatio6: q('MA_FILL', 'MA.ALG.RATIO.RATIO', 3, 2, '化简比 12:18=（     ）；它的比值是（     ）。', [], '2:3 2/3', '化简比的结果还是比，比值是一个数，两者写法不同'),
  maCircFill6: q('MA_FILL', 'MA.GEO.PERI.CIRCLE', 3, 2, '圆的半径是 3 cm，它的周长是（    ）cm，面积是（    ）cm²。（π 取 3.14）', [], '18.84 28.26', '周长公式 2πr 与面积公式 πr² 混用'),
  // ── 图形与统计 ──
  maPerim3: q('MA_GEO_CALC', 'MA.GEO.PERI.RECT', 4, 2, '长方形的长是 12 cm，宽是 7 cm，周长是（  ）cm；正方形的边长是 9 cm，周长是（  ）cm。[图]', [], '38 36', '把周长公式和面积公式用混了', [], IMG),
  maAreaRect3: q('MA_GEO_CALC', 'MA.GEO.AREA.RECT', 4, 2, '求下面长方形的面积。[图]（图中标注：长 15 m，宽 8 m）', [], '120 平方米', '面积单位写成了长度单位', [], IMG),
  maAngle4: q('MA_MEASURE', 'MA.GEO.SHAPE.ANGLE_MEASURE', 5, 3, '用量角器量出下面这个角的度数，再画一个 65° 的角。[图]', [], '', '量角器内外圈刻度读反', [], IMG),
  maDraw4: q('MA_DRAW', 'MA.GEO.SHAPE.PARALLEL', 5, 3, '过 A 点画已知直线的垂线，再过 B 点画它的平行线。[图]', [], '', '', [], IMG),
  maSym4: q('MA_DRAW', 'MA.GEO.POS.SYM', 4, 2, '画出下面图形的另一半，使它成为轴对称图形。[图]', [], '', '对应点到对称轴的距离没有量准', [], IMG),
  maView4: q('MA_CHOICE', 'MA.GEO.SOLID.VIEW', 2, 2, '从左面看下面的立体图形，看到的是（  ）。[图]', ['A. [图]', 'B. [图]', 'C. [图]'], 'B', '', [], IMG),
  maBar4: q('MA_CHART', 'MA.STAT.CHART.BAR', 6, 2, '根据条形统计图回答问题（每格表示 5 人）：四（1）班喜欢足球的有（  ）人，比喜欢篮球的多（  ）人。[图]', [], '25 10', '先看清每一格代表几，容易按 1 格 = 1 人来数', [], IMG),
  maAvg4: q('MA_WORD', 'MA.STAT.AVG', 5, 3, '小明五次跳绳的成绩分别是 98、105、112、96、109 个，平均每次跳多少个？', [], '104 个', '平均数要先求总数再除以次数'),
  maAreaPoly5: q('MA_GEO_CALC', 'MA.GEO.AREA.POLYGON', 6, 3, '计算下面图形的面积。[图：平行四边形，底 12 cm，高 5 cm；三角形，底 8 cm，高 6 cm]', [], '60 cm²  24 cm²', '三角形面积忘记除以 2', [], IMG),
  maComposite5: q('MA_GEO_CALC', 'MA.GEO.AREA.COMPOSITE', 6, 4, '求阴影部分的面积。[图：长方形里有一个三角形和一个半圆，数据已标注]', [], '', '阴影面积要用大图形减去空白部分，容易漏减一块', [], IMG),
  maGrid5: q('MA_DRAW', 'MA.GEO.POS.GRID', 5, 3, '在方格纸上标出 A(2,3)、B(5,3)、C(5,6)，顺次连接，画出的是（     ）三角形。[图：方格纸]', [], '等腰直角', '数对里先写列再写行，容易写反', [], IMG),
  maCircle6: q('MA_GEO_CALC', 'MA.GEO.AREA.CIRCLE', 5, 3, '一个圆形花坛的直径是 8 m，它的周长和面积各是多少？[图]', [], '25.12 m  50.24 m²', '直径当成半径代入面积公式', [], IMG),
  maCyl6: q('MA_GEO_CALC', 'MA.GEO.SOLID.CYLINDER', 6, 4, '一个圆柱的底面半径是 3 cm，高是 10 cm，求它的侧面积和体积。[图]', [], '188.4 cm²  282.6 cm³', '侧面积和表面积分不清', [], IMG),
  // ── 应用题 ──
  maWord3: q('MA_WORD', 'MA.PROB.BASIC.MULTI', 5, 2, '学校买了 4 箱彩笔，每箱 12 盒，每盒 6 支。一共买了多少支彩笔？', [], '288 支'),
  maWord3b: q('MA_WORD', 'MA.PROB.BASIC.MULDIV', 5, 3, '三（2）班 42 人去划船，每条船限乘 6 人，至少要租几条船？', [], '7 条', '有余数的时候不能直接舍去，要进一'),
  maGeoWord3: q('MA_WORD', 'MA.PROB.GEO', 6, 3, '一块长方形菜地长 24 米，宽 15 米。给菜地围一圈篱笆，篱笆长多少米？每平方米种 4 棵白菜，一共种多少棵？', [], '78 米 1440 棵', '求周长和求面积要分清'),
  maOverlap3: q('MA_REASON', 'MA.THINK.OVERLAP', 5, 4, '三（1）班参加合唱的有 18 人，参加舞蹈的有 15 人，两项都参加的有 6 人，一共有多少人参加了这两个活动？', [], '27 人', '两项都参加的人被数了两次，要减去一次'),
  maPrice4: q('MA_WORD', 'MA.PROB.MODEL.PRICE', 6, 3, '张老师买了 6 个篮球，每个 58 元；又买了 8 个足球，每个 45 元。付给店员 800 元，应找回多少元？', [], '92 元', '应该找回的钱 = 付的钱 - 总价，容易算成总价'),
  maTravel4: q('MA_WORD', 'MA.PROB.MODEL.TRAVEL', 6, 3, '一辆汽车每小时行 72 千米，从甲地到乙地用了 5 小时；返回时每小时行 60 千米，返回要用多少小时？', [], '6 小时', '返回的路程和去时一样，要先求出总路程'),
  maChicken4: q('MA_WORD', 'MA.THINK.CHICKEN', 6, 5, '笼子里有鸡和兔共 20 只，一共有 56 条腿。鸡和兔各有多少只？', [], '鸡 12 只，兔 8 只', '假设全是鸡之后，多出的腿数要除以 2，容易直接除以 4'),
  maFracPart5: q('MA_WORD', 'MA.PROB.FRAC.PART', 6, 3, '修一条 360 米的路，已经修了 3/8，还剩多少米？', [], '225 米', '问的是还剩多少，容易把已修的当成答案'),
  maPct6w: q('MA_WORD', 'MA.PROB.FRAC.PCT', 6, 4, '某商品原价 240 元，现在打八折出售，现价多少元？比原价便宜了百分之几？', [], '192 元  20%', '「打八折」是原价的 80%，容易算成便宜了 80%'),
  maScale6: q('MA_WORD', 'MA.ALG.RATIO.SCALE', 6, 4, '在比例尺是 1:2000000 的地图上，量得甲、乙两地相距 4.5 cm，实际距离是多少千米？', [], '90 千米', '厘米换算成千米时容易错一位'),
  maWork6: q('MA_WORD', 'MA.PROB.MODEL.WORK', 6, 5, '一项工程，甲队单独做 10 天完成，乙队单独做 15 天完成。两队合作几天完成？', [], '6 天', '要把工作总量看作单位「1」，再用分数表示工作效率'),
  maPigeon6: q('MA_REASON', 'MA.THINK.PIGEON', 6, 5, '任意 13 个同学中，至少有几个同学的生日在同一个月？说明理由。', [], '至少 2 个', '「至少」要考虑最不利的情况，容易只写答案不写理由')
}

const P = (key: string, grade: SamplePaper['grade'], semester: '上' | '下', year: number, exam: '期中' | '期末', textbook: string, qs: string[]): SamplePaper =>
  ({ key, subject: 'math', grade, semester, year, exam, textbook, region: '示例市', qs })

/**
 * 8 份数学示例卷。设计要点：四年级 2024 学年有大数、近似数、小数点移动和条形统计图，2025 学年不再考；
 * 2025 学年新增运算律、简便计算、平均数，所以同比有「新增 / 消失」可看。
 */
export const MATH_PAPERS: SamplePaper[] = [
  P('m-2024-g3-mid', '3', '上', 2024, '期中', '人教版', ['maOral3', 'maVert3', 'maUnitTime3', 'maJudge3', 'maShape3', 'maDecMean3', 'maPattern3', 'maPerim3', 'maWord3', 'maWord3b']),
  P('m-2024-g3-fin', '3', '下', 2024, '期末', '人教版', ['maOral3', 'maVert3b', 'maUnitMass3', 'maCalendar3', 'maJudge3', 'maAreaRect3', 'maUnitArea3', 'maOverlap3', 'maWord3b', 'maGeoWord3']),
  P('m-2024-g4-mid', '4', '上', 2024, '期中', '人教版', ['maOral4', 'maVert4', 'maLarge4', 'maApprox4', 'maShift4', 'maAngle4', 'maDraw4', 'maBar4', 'maPrice4']),
  P('m-2024-g4-fin', '4', '下', 2024, '期末', '人教版', ['maOral4', 'maStep4', 'maShift4', 'maDecProp4', 'maTri4', 'maBar4', 'maSym4', 'maTravel4', 'maChicken4']),
  P('m-2025-g4-mid', '4', '上', 2025, '期中', '北师大版', ['maOral4', 'maVert4', 'maLaw4', 'maSimple4', 'maAvg4', 'maTri4', 'maAngle4', 'maPrice4', 'maTravel4']),
  P('m-2025-g4-fin', '4', '下', 2025, '期末', '北师大版', ['maOral4', 'maStep4', 'maSimple4', 'maLaw4', 'maAvg4', 'maView4', 'maDraw4', 'maPrice4', 'maChicken4']),
  P('m-2025-g5-mid', '5', '上', 2025, '期中', '北师大版', ['maOral5', 'maVert5', 'maStepFrac5', 'maEq5', 'maLetter5', 'maLetterExpr5', 'maChoiceFactor5', 'maSimplify5', 'maAreaPoly5', 'maComposite5', 'maGrid5', 'maFracPart5']),
  P('m-2025-g6-fin', '6', '下', 2025, '期末', '人教版', ['maOral6', 'maStepFrac6', 'maNeg6', 'maPct6', 'maRatio6', 'maCircFill6', 'maCircle6', 'maCyl6', 'maScale6', 'maPct6w', 'maWork6', 'maPigeon6'])
]
