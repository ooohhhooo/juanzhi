interface ElectronAPI {
  getPathForFile(file: File): string
  papers: {
    import(paths: string[], opts?: { allowDuplicates?: string[] }): Promise<ImportResult[]>
    assets(paperId: string): Promise<PaperAsset[]>
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
  ai: {
    presets(): Promise<ProviderPreset[]>
    getConfig(): Promise<AiConfigView>
    saveConfig(cfg: AiConfig, apiKey?: string | null): Promise<AiConfigView>
    test(req: { kind: 'text' | 'vision'; cfg?: Partial<AiConfig>; apiKey?: string }): Promise<{ ok: boolean; message: string; latencyMs: number; model: string }>
    prompts(): Promise<{ defaultVersion: string; items: PromptView[] }>
    savePrompt(id: string, part: string, text: string): Promise<boolean>
    resetPrompt(id: string, part: string): Promise<boolean>
    usage(paperId?: string): Promise<UsageRow[]>
    compareAnalysis(scope: CompareScope): Promise<AnalysisState>
    analyzeCompare(scope: CompareScope, requestId: string): Promise<AnalysisResult>
    cancel(requestId: string): Promise<boolean>
  }
  stats: {
    overview(filter?: StatsFilter): Promise<OverviewResult>
    distribution(filter?: StatsFilter): Promise<Distribution>
    matrix(filter: StatsFilter | undefined, level: number): Promise<MatrixResult>
    hot(filter: StatsFilter | undefined, level: number): Promise<HotResult>
    compare(filter: StatsFilter | undefined, target: number, base: 'before' | number, level?: number, align?: boolean): Promise<CompareResult>
    notes(filter?: StatsFilter): Promise<ScopeNotes>
    questions(filter: StatsFilter | undefined, side: QuestionSide, code: string, limit?: number): Promise<QuestionCard[]>
    filterOptions(filter?: StatsFilter): Promise<{ years: number[]; textbooks: string[]; regions: string[] }>
    exportMatrix(filter: StatsFilter | undefined, level: number): Promise<{ saved: boolean; path?: string; bytes?: number }>
  }
  report: {
    list(): Promise<ReportItem[]>
    get(id: string): Promise<ReportDetail | null>
    preview(filter?: StatsFilter): Promise<ReportPreview>
    generate(filter: StatsFilter | undefined, requestId: string): Promise<AnalysisResult & { reportId?: string }>
    delete(id: string): Promise<boolean>
    export(id: string, fmt: 'md' | 'pdf'): Promise<{ saved: boolean; path?: string; dir?: string | null; images?: number; missingImages?: number; bytes?: number }>
  }
  data: {
    info(): Promise<DataInfo>
    exportPack(): Promise<{ saved: boolean; path?: string; bytes?: number; entries?: number; manifest?: PackManifest }>
    pickPack(): Promise<{ picked: false } | { picked: true; token: string; fileName: string; manifest: PackManifest; info: { originalVersion: number; migrated: boolean; papers: number; questions: number; pages: number; samplePapers: number }; summary: PackSummary }>
    importPack(token: string, mode: 'merge' | 'overwrite'): Promise<ImportReport>
    discardPack(token: string): Promise<boolean>
    deleteBackup(name: string): Promise<boolean>
    openBackup(name: string): Promise<boolean>
    chooseDir(): Promise<{ picked: false } | { picked: true; token?: string; path: string; ok: boolean; kind?: 'empty' | 'existing-data'; reason?: string; existing?: { papers: number; version: number } }>
    changeDir(token: string, mode: 'move' | 'use'): Promise<{ restartRequired: boolean; mode: string; target: string; oldDir: string; files?: number; bytes?: number; backupFiles?: number; backupBytes?: number }>
    resetDir(): Promise<{ restartRequired: boolean; target: string; hasData: boolean }>
    sampleStatus(): Promise<{ loaded: boolean; papers: number; questions: number }>
    loadSample(): Promise<{ papers: number; questions: number; alreadyLoaded: boolean }>
    clearSample(): Promise<{ papers: number; reports: number }>
  }
  app: {
    info(): Promise<AppInfo>
    restart(): Promise<boolean>
  }
  parse: {
    start(paperId: string, stage?: 'extract' | 'ai' | 'locate'): Promise<boolean>
    cancel(paperId: string): Promise<boolean>
  }
  queue: {
    state(): Promise<QueueState>
    pause(): Promise<boolean>
    resume(): Promise<boolean>
  }
  questions: {
    list(paperId: string): Promise<QuestionList>
    summary(): Promise<Array<{ paper_id: string; total: number; reviewed: number; attention: number }>>
    update(id: string, patch: QuestionPatch): Promise<QuestionView | null>
    remove(id: string): Promise<boolean>
    split(id: string, body: { first: { stem: string; options: string[] }; second: { no_label: string; stem: string; options: string[] } }): Promise<string>
    merge(id: string): Promise<boolean>
    confirmPaper(paperId: string, markAll: boolean): Promise<boolean>
    reopen(paperId: string): Promise<boolean>
  }
  taxonomy: {
    tree(opts?: { includeDeprecated?: boolean }): Promise<{ kps: KpNode[]; qtypes: QtypeRow[] }>
    save(ops: TaxonomyOpInput[]): Promise<{ ops: number; touched: string[] }>
    approveSuggestion(questionId: string, body: { parent_code: string | null; name: string }): Promise<string>
    rejectSuggestion(questionId: string): Promise<boolean>
  }
  ocr: {
    status(): Promise<{ available: boolean; detail: string; lang?: string }>
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
  warning: string | null
  duplicate_of: string | null
  prompt_version: string | null
  ai_meta_json: string | null
  parse_stage: string | null
  error_stage: string | null
  parsed_at: string | null
  /** 示例数据（M4）：1 = 内置的合成示例卷，不参与真实数据的统计 */
  is_sample?: number
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
  ocr_error: string | null
  text_layer_chars: number | null
}

interface ImportResult {
  path: string
  fileName: string
  paperId?: string
  error?: string
  code?: 'duplicate'
  duplicateOf?: { id: string; title: string; parseFailed?: boolean }
}

interface PaperAsset {
  id: number
  paper_id: string
  page_idx: number
  seq: number
  rel_path: string
  mime: string
  bytes: number
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


interface AiConfig {
  provider: string
  base_url: string
  model: string
  vision_model: string
  concurrency: number
  auto_parse: boolean
  batch_pages: number
  timeout_sec: number
  max_tokens: number
}

interface AiConfigView extends AiConfig {
  hasKey: boolean
  keyStorage: 'encrypted' | 'memory' | 'none'
}

interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  model: string
  visionModel: string
  keyHint: string
  models: string[]
}

interface PromptView {
  id: string
  part: 'system' | 'user'
  title: string
  text: string
  defaultText: string
  isCustom: boolean
  unknownPlaceholders: string[]
  usedInM2: boolean
}

interface UsageRow {
  model: string
  calls: number
  prompt: number
  completion: number
  cached: number
  failed?: number
}

interface QueueState {
  paused: boolean
  concurrency: number
  aiReady: boolean
  extract: { waiting: string[]; running: string | null }
  parse: {
    waiting: Array<{ paperId: string; fromStage: string | null }>
    running: Array<{ paperId: string; fromStage: string | null; stage: string; progress: number; message: string }>
  }
}

interface QuestionView {
  id: string
  paper_id: string
  ord: number
  no: string
  section: string
  section_title: string
  qtype: string
  material_id: string | null
  stem: string
  options: string[]
  answer: string
  score: number | null
  difficulty: number
  error_prone: boolean
  error_reason: string
  page_idx: number | null
  bbox: number[] | null
  bbox_source: string
  confidence: number
  reviewed: boolean
  kp_suggestion: string
  kp_suggestion_status: string | null
  flags: string[]
  edited: boolean
  kp_main: string | null
  kp_secondary: string[]
}

interface QuestionPatch {
  no_label?: string
  section?: string
  qtype?: string
  stem?: string
  options?: string[]
  answer?: string
  score?: number | null
  difficulty?: number
  error_prone?: boolean
  error_reason?: string
  bbox?: number[] | null
  page_idx?: number
  kp_main?: string | null
  kp_secondary?: string[]
  reviewed?: boolean
}

interface QuestionList {
  questions: QuestionView[]
  materials: Array<{ mid: string; section: string; kind: string; text: string; page_idx: number }>
  notes: string[]
  lowConfidence: number
  run: { id: number; prompt_version: string | null; model: string | null; vision_model: string | null; status: string; finished_at: string | null } | null
}

interface KpNode {
  code: string
  parent_code: string | null
  name: string
  level: number
  intro_grade: number | null
  sort: number
  deprecated: number
  merged_into?: string | null
  note: string | null
  builtin: number
}

type TaxonomyOpInput =
  | { op: 'add'; parent_code: string | null; name: string; note?: string; intro_grade?: number | null }
  | { op: 'update'; code: string; name?: string; note?: string | null; intro_grade?: number | null }
  | { op: 'move'; code: string; parent_code: string | null }
  | { op: 'merge'; code: string; into: string }
  | { op: 'deprecate'; code: string; deprecated: boolean }
  | { op: 'delete'; code: string }

interface QtypeRow {
  code: string
  name: string
  group: string
  note: string | null
}

// ── M3：统计 ──（类型直接取自主进程的统计模块，避免两边各写一份）
type StatsFilter = import('../main/stats/filter').StatsFilter
type Distribution = import('../main/stats/core').Distribution
type DistNode = import('../main/stats/core').DistNode
type MatrixResult = import('../main/stats/core').MatrixResult
type HotResult = import('../main/stats/core').HotResult
type HotRow = import('../main/stats/core').HotRow
type CompareResult = import('../main/stats/core').CompareResult
type CompareItem = import('../main/stats/core').CompareItem
type OverviewResult = import('../main/stats/core').OverviewResult
type QuestionCard = import('../main/stats/core').QuestionCard
type ScopeNotes = import('../main/stats/core').ScopeNotes
type CitationRef = import('../shared/citation').CitationRef
type QuestionSide = { kind: 'year'; year: number } | { kind: 'base'; target: number; base: 'before' | number; align?: boolean } | { kind: 'filter' }

interface CompareScope {
  filter: StatsFilter
  target: number
  base: 'before' | number
  level: number
  /** 按学期对齐（基线只取目标学年出现过的学期），默认 true */
  align?: boolean
}

interface AnalysisState {
  status: 'none' | 'fresh' | 'stale'
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
  model: string | null
  createdAt: string | null
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  blocked: string | null
  aiReady: boolean
  promptVersion: string
}

interface AnalysisResult {
  ok: boolean
  cancelled?: boolean
  code?: string
  message?: string
  partial?: string
  markdown?: string
  refs?: CitationRef[]
  warnings?: string[]
}

type ChunkEvent =
  | { id: string; type: 'start'; scopeKey: string; refs: CitationRef[] }
  | { id: string; type: 'delta'; text: string }
  | { id: string; type: 'reset' }
  | { id: string; type: 'done'; markdown: string; refs: CitationRef[]; warnings: string[]; reportId?: string }
  | { id: string; type: 'error'; code: string; message: string; partial: string }
  | { id: string; type: 'cancelled'; partial: string }

// ── M4：报告与数据 ──
interface ReportItem {
  id: string
  title: string
  createdAt: string
  model: string | null
  filter: StatsFilter
  filterDesc: string
  status: 'fresh' | 'stale'
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  sampleWarning: string | null
  promptVersion: string | null
  chars: number
}
interface ReportDetail extends ReportItem {
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
}
interface ReportPreview {
  filterDesc: string
  papers: number
  questions: number
  blocked: string | null
  aiReady: boolean
  busy: boolean
}
interface PackManifest {
  format: string
  formatVersion: number
  schemaVersion: number
  appVersion: string
  exportedAt: string
  paperCount: number
  questionCount: number
  pageCount?: number
  fileCount?: number
  platform?: string
}
interface PackSummary {
  papersInPack: number
  questionsInPack: number
  pagesInPack: number
  papersNew: number
  papersExisting: number
  sameFileAsExisting: number
  customKps: number
  samplesIgnored: number
  missingPageImages: number
  livePapers: number
}
interface ImportReport {
  mode: 'merge' | 'overwrite'
  papersAdded: number
  papersSkipped: number
  sameFileAsExisting: number
  questionsAdded: number
  kpsAdded: number
  kpsRemapped: number
  reportsAdded: number
  missingPageImages: number
  promptsImported: number
  promptsKeptLocal: number
  warnings: string[]
  backup?: { dir: string; dbFile: string; filesDir: string; bytes: number }
}
interface DataInfo {
  dataDir: string
  defaultDir: string
  custom: boolean
  restartPending: boolean
  dbBytes: number
  filesBytes: number
  papers: number
  backups: Array<{ name: string; dir: string; createdAt: string; bytes: number }>
}
interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  schema: number
  dataDir: string
  restartPending: boolean
  restartTarget: string
  restartOldDir: string
  /** 启动时数据库恢复的结果（上次导入中途崩溃）；没有就是 null */
  startupNotice: { kind: 'recovered' | 'failed'; message: string } | null
}
