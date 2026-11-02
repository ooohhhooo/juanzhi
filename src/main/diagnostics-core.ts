/**
 * 诊断信息的纯函数部分（不依赖 electron，单测直接加载）：配置脱敏、CSV、说明文字、清单。
 * 诊断包只在本机生成、由用户自己发给开发者；默认不含任何学生数据：没有试卷标题 / 文件名 / 题目 / 报告 / 课程内容 / 姓名，没有密钥和完整服务地址。
 */

export interface DiagEntryMeta { name: string; desc: string; bytes: number }

/** 永远不会进诊断包的东西（预览对话框里原样展示给用户） */
export const DIAG_NEVER_INCLUDED: string[] = [
  'API Key（只记「已设置 / 未设置」）和完整的服务地址（只保留主机名）',
  '试卷标题、文件名、学校和学生姓名（试卷在文件里只用 8 位编号）',
  '题目内容、试卷页面图片和识别出来的文字',
  '报告内容、课程大纲内容',
  '发给 AI 的提示词和 AI 返回的正文'
]

/** 设置里名字像密钥的字段一律丢掉；服务地址只留主机名；只保留数字 / 布尔 / 短文字 */
export function scrubConfig(cfg: Record<string, unknown>, hasKey: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (/key|secret|password|token(?!s)|authorization|credential/i.test(k) && k !== 'max_tokens' && !/^max_tokens/.test(k)) continue
    if (k === 'base_url') {
      let host = ''
      try { host = new URL(String(v)).host } catch { /* 空或非法 */ }
      out.base_host = host
      continue
    }
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v
  }
  out.api_key = hasKey ? '已设置' : '未设置'
  return out
}

/** CSV 一格：含逗号 / 引号 / 换行时加引号；以 = + - @ 开头的加前导单引号，防止被表格软件当公式 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n'
}

export const shortPaperId = (id: string): string => id.slice(0, 8)

export function buildReadme(version: string, generatedAt: string): string {
  return [
    '卷知 · 诊断信息',
    `生成时间：${generatedAt}　软件版本：${version}`,
    '',
    '这是什么：这个压缩包是在你的电脑上生成的，用来帮开发者查找软件的问题。它不会自动上传到任何地方。',
    '怎么用：到 https://github.com/ooohhhooo/juanzhi/issues 新建一条反馈，把这个压缩包作为附件拖进去。反馈里不要写学生姓名和 API Key。',
    '',
    '里面有什么：',
    '  summary.json   软件版本、系统、内存、磁盘剩余空间、数据库版本、各状态试卷数量',
    '  config.json    AI 服务商和模型名、并发数等设置（API Key 只写「已设置」，服务地址只留主机名）',
    '  ocr.json       文字识别组件是否可用',
    '  papers.csv     每份试卷一行：8 位编号、状态、页数、题数、出错的阶段（不含标题和文件名）',
    '  ai-usage.csv   各模型各类调用的次数、失败次数和 token 用量',
    '  queue.json     处理队列的状态（排队数、并发、是否被服务商限速）',
    '  settings.json  界面设置（不含密钥）',
    '  logs/          最近的运行日志（只记事件、耗时、状态码，不含试卷内容和密钥）',
    '',
    '永远不包含：',
    ...DIAG_NEVER_INCLUDED.map(x => `  · ${x}`),
    ''
  ].join('\n')
}

/** 「复制简短诊断」：5 行文字，粘贴到反馈里 */
export function shortDiagnosis(i: { version: string; platform: string; arch: string; osRelease: string; model: string; visionModel: string; ocr: string }): string {
  return [
    `卷知版本：${i.version}`,
    `系统：${i.platform} ${i.arch}（${i.osRelease}）`,
    `AI 模型：${i.model || '未设置'}`,
    `视觉模型：${i.visionModel || '未设置'}`,
    `文字识别：${i.ocr}`
  ].join('\n')
}

/** 反馈页地址：预填标题和版本、系统；正文里提醒附上诊断包、不要写学生姓名和密钥。长度控制在安全范围内 */
export function feedbackUrl(i: { version: string; platform: string; arch: string; osRelease: string }): string {
  const body = [
    '## 问题描述',
    '（发生了什么？你期待的是什么？）',
    '',
    '## 环境',
    `- 卷知版本：${i.version}`,
    `- 系统：${i.platform} ${i.arch}（${i.osRelease}）`,
    '',
    '## 诊断信息',
    '请先在 设置 → 关于 → 导出诊断信息，把生成的 zip 文件拖到这里。',
    '',
    '提醒：请不要在反馈里写学生姓名、不要贴 API Key。'
  ].join('\n')
  const q = new URLSearchParams({ title: `[公测] `, body, labels: 'beta' })
  return `https://github.com/ooohhhooo/juanzhi/issues/new?${q.toString()}`
}
