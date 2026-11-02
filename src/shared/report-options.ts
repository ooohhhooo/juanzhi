/**
 * 生成报告时的可选项（存进 reports.options_json，参与缓存键）。附加段（课程对照、家长版一句话……）读取它决定要不要跑。
 * 没有任何选项时等于 {}，和 beta.3 之前的报告完全一致。
 */
export interface ReportOptions {
  /** 加入课程对照：用哪几个课程体系 */
  course?: { outlineIds: string[] }
  /** 家长版结尾追加一句课程建议 */
  parentHint?: boolean
}
