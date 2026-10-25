// 试卷状态流：imported → extracting → extracted → (M2) parsing → reviewing → done；任何阶段都可能 failed
export const statusMap: Record<string, { color: string; label: string }> = {
  imported: { color: 'default', label: '排队中' },
  extracting: { color: 'processing', label: '提取中' },
  extracted: { color: 'success', label: '已提取' },
  parsing: { color: 'processing', label: '解析中' },
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
  if (paper.status === 'extracting' && progress) return { ...s, label: `${s.label} ${progress.progress}%` }
  if (paper.status === 'extracted' && paper.warning) return { color: 'warning', label: '已提取·有提示', title: paper.warning }
  return { ...s, title: paper.error ?? undefined }
}
