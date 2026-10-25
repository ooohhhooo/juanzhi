interface ElectronAPI {
  getPathForFile(file: File): string
  papers: {
    import(paths: string[]): Promise<Array<{ path: string; fileName: string; paperId?: string; error?: string }>>
    reprocess(id: string): Promise<boolean>
    list(filter?: Record<string, unknown>): Promise<Paper[]>
    get(id: string): Promise<Paper | null>
    update(id: string, meta: Record<string, unknown>): Promise<Paper>
    remove(id: string): Promise<boolean>
    pages(paperId: string): Promise<PageRecord[]>
  }
  settings: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<boolean>
    getDataDir(): Promise<string>
    openDataDir(): Promise<boolean>
  }
  dialog: {
    openFiles(): Promise<string[]>
  }
  on(channel: string, callback: (...args: any[]) => void): () => void
}

interface Paper {
  id: string
  title: string
  grade: string | null
  semester: string | null
  school_year_start: number | null
  exam_type: string | null
  textbook: string | null
  region: string | null
  school: string | null
  total_score: number | null
  file_name: string
  file_hash: string
  status: string
  error: string | null
  page_count: number
  ai_model: string | null
  created_at: string
  extracted_at: string | null
}

interface PageRecord {
  id: number
  paper_id: string
  idx: number
  image_rel: string
  width: number
  height: number
  text_source: string
  lines_json: string
  text: string | null
  ocr_conf: number | null
}

interface JobProgress {
  paperId: string
  stage: string
  progress: number
  message: string
}

interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  conf: number
}

interface Window {
  api: ElectronAPI
}
