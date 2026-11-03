/** 演示用的看板规格（全部虚构）：覆盖所有块类型和图表种类，演示路由 /analysis-demo、单测、e2e 共用 */
import { parseBoardSpec, type BoardSpec } from './spec.ts'

const classes = ['甲班', '乙班', '丙班', '丁班', '戊班', '己班']
const months = ['3月', '4月', '5月', '6月', '7月', '8月']

export function demoSpec(): BoardSpec {
  return parseBoardSpec({
    title: '示例学期学情分析',
    subtitle: '虚构数据，仅用于演示看板的各种块',
    dataNote: '示例学校 · 2026 春季学期 · 6 个班共 240 名学生（虚构）',
    findings: [
      { title: '阅读理解失分最集中', body: '阅读理解平均得分率 61.2%，比语法低 14.5 个百分点；丙班、丁班低于 55%。' },
      { title: '期中后整体回升', body: '6 个班平均分从 3 月的 71.3 升到 8 月的 78.6，提升 7.3 分。' },
      { title: '12 名学生需要重点跟进', body: '连续两次测验低于 60 分的学生有 12 人，集中在丙班（5 人）和丁班（4 人）。' }
    ],
    sections: [
      {
        id: 'overview', title: '整体表现', intro: '先看全年级的总体水平，再看各班差异。',
        blocks: [
          { type: 'kpi', items: [{ label: '参与学生', value: '240 人' }, { label: '平均分', value: '78.6', delta: '+7.3', deltaGood: 'up' }, { label: '不及格率', value: '8.3%', delta: '-2.1%', deltaGood: 'down' }, { label: '缺考', value: '6 人' }], source: { queryId: 'q-001' } },
          { type: 'chart', chart: { kind: 'bar', title: '各班平均分', categories: classes, series: [{ name: '平均分', values: [82.4, 79.1, 70.3, 72.8, 80.5, 77.2], unit: '分' }], valueFormat: 'score' }, source: { queryId: 'q-002' } },
          { type: 'chart', chart: { kind: 'barH', title: '各知识点得分率', categories: ['词汇', '语法', '阅读理解', '完形填空', '书面表达', '听力理解', '交际用语'], series: [{ name: '得分率', values: [0.812, 0.757, 0.612, 0.668, 0.703, 0.789, 0.834] }], valueFormat: 'percent', notes: '得分率 = 实际得分 / 满分。' }, source: { queryId: 'q-003' } }
        ]
      },
      {
        id: 'distribution', title: '成绩分布', intro: '各分数段的人数，以及各班优良中差的构成。',
        blocks: [
          { type: 'chart', chart: { kind: 'stackedBar', title: '各班成绩构成', categories: classes, series: [{ name: '优秀', values: [18, 14, 7, 9, 16, 12] }, { name: '良好', values: [14, 15, 12, 13, 14, 15] }, { name: '及格', values: [7, 9, 15, 13, 8, 10] }, { name: '不及格', values: [1, 2, 6, 5, 2, 3] }], valueFormat: 'number' }, source: { queryId: 'q-004' } },
          { type: 'chart', chart: { kind: 'groupedBar', title: '期中与期末平均分', categories: classes, series: [{ name: '期中', values: [78.1, 75.3, 66.2, 68.9, 77.0, 73.4] }, { name: '期末', values: [82.4, 79.1, 70.3, 72.8, 80.5, 77.2] }], valueFormat: 'score' } },
          { type: 'chart', chart: { kind: 'pie', title: '各档学生占比', categories: ['优秀', '良好', '及格', '不及格'], series: [{ name: '人数', values: [76, 83, 62, 19] }], valueFormat: 'number' } }
        ]
      },
      {
        id: 'trend', title: '趋势与关联', intro: '逐月变化，以及练习量和成绩的关系。',
        blocks: [
          { type: 'chart', chart: { kind: 'line', title: '月度平均分', categories: months, series: [{ name: '甲班', values: [76.5, 78.0, 79.2, 80.1, 81.3, 82.4] }, { name: '丙班', values: [64.2, 65.0, 66.8, 67.5, 69.1, 70.3] }], valueFormat: 'score' } },
          { type: 'chart', chart: { kind: 'scatter', title: '周练习时长与平均分', categories: classes, series: [{ name: '周练习时长（小时）', values: [4.5, 3.8, 2.1, 2.6, 4.1, 3.4] }, { name: '平均分', values: [82.4, 79.1, 70.3, 72.8, 80.5, 77.2] }], valueFormat: 'number' } },
          { type: 'chart', chart: { kind: 'heatRow', title: '各班 × 知识点得分率', categories: ['词汇', '语法', '阅读', '写作', '听力'], series: [{ name: '甲班', values: [0.88, 0.82, 0.7, 0.75, 0.86] }, { name: '乙班', values: [0.84, 0.79, 0.64, 0.7, 0.8] }, { name: '丙班', values: [0.74, 0.68, 0.52, 0.6, 0.72] }, { name: '丁班', values: [0.76, 0.7, 0.54, 0.63, 0.74] }], valueFormat: 'percent' } }
        ]
      },
      {
        id: 'followup', title: '重点跟进名单', intro: '连续两次低于 60 分的学生（姓名为虚构）。',
        blocks: [
          { type: 'table', title: '跟进名单（部分）', columns: [{ key: 'name', label: '学生' }, { key: 'cls', label: '班级' }, { key: 'last', label: '最近得分', format: 'score' }, { key: 'rate', label: '阅读得分率', format: 'percent' }, { key: 'n', label: '缺课次数', format: 'number' }], rows: [{ name: '学生甲', cls: '丙班', last: 52.5, rate: 0.41, n: 3 }, { name: '学生乙', cls: '丙班', last: 57, rate: 0.48, n: 1 }, { name: '学生丙', cls: '丁班', last: 55.5, rate: 0.52, n: 0 }, { name: '学生丁', cls: '丁班', last: 58, rate: 0.55, n: 2 }, { name: '学生戊', cls: '乙班', last: 59, rate: 0.6, n: 0 }], highlight: { rule: { key: 'rate', op: '<', value: 0.5 } }, source: { queryId: 'q-005' } },
          { type: 'text', markdown: '**建议**：先从阅读入手，每周安排两次 20 分钟的限时精读；缺课超过 2 次的学生优先补课。' }
        ]
      }
    ],
    caliber: ['得分率 = 实际得分 / 满分，缺考不计入。', '班级平均分按学生个人成绩平均，不按题目平均。', '以上为虚构的演示数据。']
  })
}
