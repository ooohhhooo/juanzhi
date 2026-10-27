// 试卷状态流：imported → extracting → extracted → (M2) parsing → reviewing → done；任何阶段都可能 failed
export const statusMap: Record<string, { color: string; label: string }> = {
  imported: { color: 'default', label: '排队中' },
  extracting: { color: 'processing', label: '提取中' },
  extracted: { color: 'success', label: '已提取' },
  parsing: { color: 'processing', label: 'AI 解析中' },
  reviewing: { color: 'warning', label: '待审核' },
  done: { color: 'success', label: '已完成' },
  failed: { color: 'error', label: '失败' }
}

export const textSourceLabel: Record<string, string> = {
  'pdf-text': 'PDF 文本层',
  ocr: 'OCR',
  docx: 'Word 文本',
  vision: '视觉模型',
  needs_ocr: '待 OCR（当前平台不支持）',
  ocr_failed: 'OCR 失败',
  none: '无文字'
}

/** 警告写在 warning 列；只有失败才有 error */
export function paperTag(paper: Paper, progress?: JobProgress): { color: string; label: string; title?: string } {
  const s = statusMap[paper.status] ?? { color: 'default', label: paper.status }
  if ((paper.status === 'extracting' || paper.status === 'parsing') && progress) return { ...s, label: `${s.label} ${progress.progress}%` }
  if (paper.status === 'extracted' && paper.warning) return { color: 'warning', label: '已提取·有提示', title: paper.warning }
  // 疑似重复的卷子默认不计入统计：状态栏不能只写「已完成」，免得被当成「已经算进去了」
  if (paper.similar_state === 'suspect' && paper.status === 'done') return { color: 'default', label: '疑似重复 · 没计入统计', title: '这份卷子像是已有卷子的一部分，默认不计入统计。确实是新卷的话，点「确实是新卷，计入统计」。' }
  if (paper.similar_state === 'suspect' && paper.status === 'reviewing') return { ...s, label: '待审核 · 疑似重复', title: '这份卷子像是已有卷子的一部分，确认后也默认不计入统计。' }
  return { ...s, title: paper.error ?? undefined }
}

/** 状态标签的样式（设计系统 StatusLabel 的 kind）：进行中 / 待处理 / 完成 / 失败 / 排队 */
export type PaperKind = 'working' | 'pending' | 'done' | 'failed' | 'queued'
export function paperKind(paper: Paper): PaperKind {
  switch (paper.status) {
    case 'extracting': case 'parsing': return 'working'
    case 'reviewing': return 'pending'
    case 'extracted': return paper.warning ? 'pending' : 'queued'
    case 'done': return paper.similar_state === 'suspect' ? 'queued' : 'done'
    case 'failed': return 'failed'
    default: return 'queued'
  }
}

/** 解析流水线的四个阶段（队列页的步骤条）。提取之后 AI 一次调用完成拆题+标注，所以「拆题标注」是一步 */
export const PIPELINE_STEPS = ['提取文字', '拆题与标注', '定位题目', '保存入库'] as const

/** 试卷当前处在第几步（0 起）、该步的状态 */
export function pipelineStep(paper: Paper, runtimeStage?: string): { index: number; state: 'wait' | 'process' | 'finish' | 'error' } {
  const parseIdx = (stage: string | null | undefined): number => {
    const s = (stage ?? '').replace(/^parse:/, '')
    if (s === 'locate') return 2
    if (s === 'save') return 3
    return 1
  }
  switch (paper.status) {
    case 'imported': return { index: 0, state: 'wait' }
    case 'extracting': return { index: 0, state: 'process' }
    case 'extracted': return { index: 1, state: 'wait' }
    case 'parsing': return { index: parseIdx(runtimeStage ?? paper.parse_stage), state: 'process' }
    case 'reviewing':
    case 'done': return { index: 3, state: 'finish' }
    case 'failed': return { index: paper.error_stage === 'parse' ? parseIdx(paper.parse_stage) : 0, state: 'error' }
    default: return { index: 0, state: 'wait' }
  }
}

/** 题目上的小标签：一句白话 + 悬停说明，告诉老师「请你看一眼什么」。内部标记名（kp_uncertain 等）不出现在界面上 */
export const flagLabel: Record<string, { text: string; hint: string }> = {
  kp_uncertain: { text: '知识点请核对', hint: 'AI 对这道题主要考什么没把握，或知识点表里没有合适的项，请核对一下' },
  kp_invalid: { text: '知识点请核对', hint: 'AI 给的知识点不在知识点表里，已退回最接近的大类，请改成合适的' },
  ocr_unclear: { text: '文字看不清', hint: '原卷这里没读清楚，题干里有 [?]，请对着原卷补全' },
  underline_lost: { text: '画线没识别出来', hint: '原卷里的下划线没识别出来（比如“选出画线部分读音不同”的题），请对着原图看' },
  needs_image: { text: '要看图才能做', hint: '这道题要看图才能作答，文字里没有图的内容' },
  stem_incomplete: { text: '题干不完整', hint: '题干或选项缺了一部分，请对照原卷补全' },
  no_number: { text: '原卷没有题号', hint: '卷面上没有题号，序号是程序编的' },
  no_section: { text: '不知道属于哪个大题', hint: '没有识别出这道题属于哪个大题' },
  bbox_uncertain: { text: '位置请核对', hint: 'AI 对这道题在原卷上的位置没有把握，请看一下中间的框对不对' },
  locate_failed: { text: '没找到位置', hint: '没能在原卷上找到这道题的位置，请在中间的原卷上手动画框' },
  locate_rescan: { text: '位置请核对', hint: '这道题的文字在卷子里出现了不止一处，位置可能指错了，请核对中间的框' },
  locate_fuzzy: { text: '位置请核对', hint: '原卷文字有识别错误，位置是大致对上的，请核对中间的框' },
  qtype_invalid: { text: '题型已改成“其他”', hint: 'AI 给的题型不在题型表里，已改成“其他”，请选一个合适的' },
  duplicate: { text: '题号重复', hint: '同一个大题里有两道题的题号一样，请看是不是拆错了' }
}

export const difficultyLabel = ['', '很容易', '较容易', '中等', '较难', '很难']
