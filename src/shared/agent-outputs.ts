/**
 * 助手会话的「产出」：汇报文档、看板、名单表格、口径说明。主进程（存储 / 导出）和渲染端（右侧面板）共用的类型与引用标签解析。
 * 纯函数，不依赖 electron，单测直接跑。
 */

export type OutputType = 'md' | 'board' | 'table' | 'note' | 'image'
export type OutputStatus = 'writing' | 'done'
export type OutputExportFormat = 'docx' | 'pdf' | 'xlsx' | 'csv' | 'md'

/** 索引里的一项（agent-outputs/<sessionId>/index.json） */
export interface OutputEntry {
  id: string
  type: OutputType
  name: string
  /** 会话目录下的文件名；看板没有文件 */
  file: string | null
  /** 看板的 id（type = board 时） */
  boardId?: string
  updatedAt: number
  status: OutputStatus
  /** 文档计划写几节（doc_create 时给了就有）；written = 已经写了几节 */
  total?: number
  written?: number
  /** 分享卡片（type = image）的来源信息 */
  card?: { kind: string; audience: string; templateId: string; width: number; height: number }
}

/** 预览用的内容 */
export type OutputContent =
  | { type: 'md' | 'note'; markdown: string; written: number; total?: number }
  | { type: 'table'; columns: string[]; rows: string[][]; totalRows: number }
  | { type: 'board'; boardId: string }
  | { type: 'image'; dataUrl: string; width: number; height: number }

export type RefType = 'query' | 'q' | 'lesson' | 'stu'
export interface RefTag { type: RefType; id: string }

/** 正文里的出处标签：[[query:12]]、[[q:abc]]、[[lesson:L3]]、[[stu:S9]] */
export const REF_TAG_RE = /\[\[(query|q|lesson|stu):([A-Za-z0-9_.-]{1,64})\]\]/g

export type RefPiece = { text: string } | { ref: RefTag }

export function splitRefTags(text: string): RefPiece[] {
  const out: RefPiece[] = []
  let last = 0
  for (const m of text.matchAll(REF_TAG_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i) })
    out.push({ ref: { type: m[1] as RefType, id: m[2] } })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

const REF_WORD: Record<RefType, string> = { query: '查询 #', q: '题 ', lesson: '课 ', stu: '学员 ' }
export const refText = (r: RefTag): string => REF_WORD[r.type] + r.id

/** 导出 Word / PDF 时把标签换成普通文字：（查询 #12） */
export function stripRefTags(md: string): string {
  return md.replace(REF_TAG_RE, (_m, t: RefType, id: string) => `（${refText({ type: t, id })}）`)
}
