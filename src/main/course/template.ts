/**
 * 空白模板和虚构示例的内容（运行时由代码生成 xlsx，仓库里不放任何课程文件）。纯函数模块。
 * 示例里的体系、级别、课程、教材名全部是虚构的；它同时是单元测试和 E2E 的夹具。
 */
import { asSubject } from '../../shared/subject.ts'

export const TEMPLATE_HEADERS = ['课次', '级别', '主题', '课程标题', '字母与语音', '词汇', '句型', '实用表达', '教材对标', '能力目标', '备注'] as const

/** 语文 / 数学的模板表头：内容列换成各学科的叫法（对应列类型 phonics / word / pattern / expression） */
export function templateHeadersOf(subject?: unknown): string[] {
  const s = asSubject(subject)
  if (s === 'math') return ['课次', '级别', '主题', '课程标题', '计算与口算', '知识点', '例题', '方法', '教材对标', '能力目标', '备注']
  if (s === 'chinese') return ['课次', '级别', '主题', '课程标题', '识字与写字', '词语积累', '阅读', '写作与表达', '教材对标', '能力目标', '备注']
  return [...TEMPLATE_HEADERS]
}

/** 空白模板：只有表头（填写说明在上传向导里，不放进文件，免得被当成一课） */
export function templateRows(subject?: unknown): string[][] {
  return [templateHeadersOf(subject)]
}

/** 虚构示例：两个级别（一个 sheet 一个级别），每个级别 5 课 */
export function sampleSheets(subject?: unknown): Array<{ name: string; rows: string[][] }> {
  const s = asSubject(subject)
  const h = templateHeadersOf(s)
  if (s === 'math') {
    return [{
      name: '五年级', rows: [h,
        ['1', '五年级', '分数', '第 1 课 分数加减', '口算', '同分母分数加减；异分母分数先通分', '1/2+1/3', '先通分再加减', '示例教材 五下 第 1 单元', '会计算异分母分数加减', ''],
        ['2', '五年级', '图形', '第 2 课 长方形的面积', '', '长方形面积 = 长 × 宽', '长 12 m、宽 8 m 的菜地', '先找长和宽再相乘', '示例教材 五上 第 2 单元', '会计算长方形面积', ''],
        ['3', '五年级', '单位', '第 3 课 面积单位', '', '1 m² = 100 dm²', '3.5 m² = （ ）dm²', '先想进率再换算', '示例教材 五上 第 3 单元', '会换算面积单位', '']
      ]
    }]
  }
  if (s === 'chinese') {
    return [{
      name: '四年级', rows: [h,
        ['1', '四年级', '字词', '第 1 课 多音字', '重（zhòng、chóng）', '重量、重复', '', '', '示例教材 四下 第 1 单元', '会区分多音字读音', ''],
        ['2', '四年级', '阅读', '第 2 课 读短文找信息', '', '', '小燕子从哪里飞回来', '带着问题读', '示例教材 四下 第 2 单元', '会在短文中找答案', ''],
        ['3', '四年级', '习作', '第 3 课 写一件事', '', '', '', '按起因、经过、结果写', '示例教材 四下 第 3 单元', '会写一件完整的事', '']
      ]
    }]
  }
  return [
    {
      name: '基础级', rows: [h,
        ['1', '基础级', '打招呼', '第 1 课 Hello', 'Aa Bb', 'hello, bye, name', "I'm …", '问好与告别', '示例教材 三上 Unit 1', '能听懂简单问候', ''],
        ['2', '基础级', '颜色', '第 2 课 Colors', 'Cc Dd', 'red, blue, green', 'What colour is it?', '询问颜色', '示例教材 三上 Unit 2', '能说出 5 种颜色', ''],
        ['3', '基础级', '数字', '第 3 课 Numbers', 'Ee Ff', 'one, two, three, four', 'How many …?', '数数', '示例教材 三上 Unit 3', '能数到 10', ''],
        ['4', '基础级', '家人', '第 4 课 Family', 'Gg Hh', 'mother, father, brother', 'This is my …', '介绍家人', '示例教材 三上 Unit 4', '能介绍家庭成员', ''],
        ['5', '基础级', '动物', '第 5 课 Animals', 'Ii Jj', 'cat, dog, fish', "It's a …", '介绍动物', '示例教材 三上 Unit 5', '能说出 5 种动物', '']
      ]
    },
    {
      name: '进阶级', rows: [h,
        ['1', '进阶级', '日常', '第 1 课 My day', '', 'breakfast, school, homework', 'I get up at …', '说一天的安排', '示例教材 四下 Unit 1', '能描述日程', ''],
        ['2', '进阶级', '天气', '第 2 课 Weather', 'ai ay', 'sunny, rainy, windy', "It's … today.", '谈论天气', '示例教材 四下 Unit 2', '能描述天气', ''],
        ['3', '进阶级', '过去的事', '第 3 课 Last weekend', 'ed', 'visited, played, watched', 'I played … yesterday.', '说周末做了什么', '示例教材 四下 Unit 3', '能说简单的过去经历', ''],
        ['4', '进阶级', '比较', '第 4 课 Who is taller?', 'er est', 'taller, shorter, heavier', 'A is taller than B.', '比较两个人或物', '示例教材 四下 Unit 4', '能用比较级描述', ''],
        ['5', '进阶级', '购物', '第 5 课 Shopping', 'sh ch', 'dress, skirt, expensive', 'How much is it?', '购物对话', '示例教材 四下 Unit 5', '能完成简单购物对话', '']
      ]
    }
  ]
}
