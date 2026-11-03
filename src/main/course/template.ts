/**
 * 空白模板和虚构示例的内容（运行时由代码生成 xlsx，仓库里不放任何课程文件）。纯函数模块。
 * 示例里的体系、级别、课程、教材名全部是虚构的；它同时是单元测试和 E2E 的夹具。
 */
export const TEMPLATE_HEADERS = ['课次', '级别', '主题', '课程标题', '字母与语音', '词汇', '句型', '实用表达', '教材对标', '能力目标', '备注'] as const

/** 空白模板：只有表头（填写说明在上传向导里，不放进文件，免得被当成一课） */
export function templateRows(): string[][] {
  return [[...TEMPLATE_HEADERS]]
}

/** 虚构示例：两个级别（一个 sheet 一个级别），每个级别 5 课 */
export function sampleSheets(): Array<{ name: string; rows: string[][] }> {
  const h = [...TEMPLATE_HEADERS]
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
