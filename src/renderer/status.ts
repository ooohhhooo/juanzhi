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
  return { ...s, title: paper.error ?? undefined }
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

export const flagLabel: Record<string, { text: string; hint: string }> = {
  kp_uncertain: { text: '知识点待确认', hint: 'AI 对知识点把握不大，或树里没有合适节点' },
  kp_invalid: { text: '知识点代码无效', hint: 'AI 给的代码不在知识点树里，已退回最近的上级' },
  ocr_unclear: { text: '文字看不清', hint: '原文识别不清，题干里有 [?]' },
  underline_lost: { text: '画线丢失', hint: 'OCR 读不到下划线，语音题请对照原卷核对' },
  needs_image: { text: '需看图', hint: '这道题要看图才能作答' },
  stem_incomplete: { text: '题干不完整', hint: '题干或选项缺失，请对照原卷补全' },
  no_number: { text: '无题号', hint: '卷面上没有题号，序号是程序编的' },
  no_section: { text: '大题不明', hint: '没有识别出所属大题' },
  bbox_uncertain: { text: '位置不确定', hint: '视觉模型对这道题的位置没有把握' },
  locate_failed: { text: '未能定位', hint: '没能在原卷上找到这道题的位置，请手动画框' },
  locate_rescan: { text: '位置待核对', hint: '位置是忽略顺序重新搜索得到的，同一段文字出现多次时可能指错，请核对框' },
  locate_fuzzy: { text: '位置为模糊匹配', hint: '原文有识别错误，位置是模糊匹配得到的' },
  qtype_invalid: { text: '题型已改为「其他」', hint: 'AI 给的题型不在题型表里' },
  duplicate: { text: '疑似重复', hint: '同一大题里题号重复' }
}

export const difficultyLabel = ['', '很容易', '较容易', '中等', '较难', '很难']
