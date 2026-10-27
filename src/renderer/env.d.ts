interface ElectronAPI {
  getPathForFile(file: File): string
  papers: {
    import(paths: string[], opts?: { allowDuplicates?: string[] }): Promise<ImportResult[]>
    assets(paperId: string): Promise<PaperAsset[]>
    reprocess(id: string): Promise<boolean>
    /** 疑似重复的卷子，老师选「确实是新卷，计入统计」 */
    acceptSimilar(id: string): Promise<boolean>
    /** 整库重新检查疑似重复卷（老卷也扫一遍） */
    scanSimilar(): Promise<{ checked: number; suspects: number }>
    /** 扫描进度（刷新页面后恢复「检查中」）；进度事件见 window.api.on('similar:progress') */
    scanSimilarStatus(): Promise<{ running: boolean; done: number; total: number; suspects: number | null }>
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
    modelProfile(model: string): Promise<ModelProfile>
    getConfig(): Promise<AiConfigView>
    saveConfig(cfg: AiConfig, apiKey?: string | null): Promise<AiConfigView>
    test(req: { kind: 'text' | 'vision'; cfg?: Partial<AiConfig>; apiKey?: string }): Promise<{ ok: boolean; message: string; latencyMs: number; model: string }>
    prompts(): Promise<{ defaultVersion: string; items: PromptView[] }>
    savePrompt(id: string, part: string, text: string): Promise<boolean>
    resetPrompt(id: string, part: string): Promise<boolean>
    usage(paperId?: string): Promise<UsageRow[]>
    compareAnalysis(scope: CompareScope): Promise<AnalysisState>
    analyzeCompare(scope: CompareScope, requestId: string): Promise<AnalysisResult>
    /** 看板抽屉里「只讲这一个考点」的 AI 分析：kpAnalysis 只读状态（不花钱），analyzeKp 流式生成（ai:chunk，ai.cancel 取消） */
    kpAnalysis(scope: KpScope): Promise<KpAnalysisState>
    analyzeKp(scope: KpScope, requestId: string): Promise<AnalysisResult>
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
    preview(filter?: StatsFilter, reader?: ReportReader): Promise<ReportPreview>
    generate(filter: StatsFilter | undefined, requestId: string, reader?: ReportReader): Promise<AnalysisResult & { reportId?: string }>
    delete(id: string): Promise<boolean>
    export(id: string, fmt: 'md' | 'pdf' | 'docx'): Promise<{ saved: boolean; path?: string; dir?: string | null; images?: number; missingImages?: number; bytes?: number }>
    /** 老师点「我已核对」。家长版必须带 acknowledged = 勾了「已确认无误」的未核实句子原文（每句未核实的话要么已删掉、要么在这里），有矛盾句或内容太少一律拒绝（白话 message）；其他版本可省略 */
    confirm(id: string, acknowledged?: string[]): Promise<boolean>
    /** 复制到微信：纯文本写进系统剪贴板，同时返回文本 */
    copyWechat(id: string): Promise<{ text: string; chars: number }>
    /** 在文件管理器里显示刚导出的文件 */
    reveal(path: string): Promise<boolean>
    /** 把报告里一句未核实 / 矛盾的话删掉（只有还没核对的报告能删）；返回更新后的报告 */
    removeSentence(id: string, sentence: string): Promise<ReportDetail>
  }
  data: {
    info(): Promise<DataInfo>
    exportPack(): Promise<{ saved: boolean; path?: string; bytes?: number; entries?: number; manifest?: PackManifest }>
    pickPack(): Promise<{ picked: false } | { picked: true; token: string; fileName: string; manifest: PackManifest; info: { originalVersion: number; migrated: boolean; papers: number; questions: number; pages: number; samplePapers: number; kpTextFolded: number }; summary: PackSummary }>
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
    /** 启动时数据库恢复的提示（上次导入中途崩溃）：只给一次，取走后主进程清掉；没有就是 null */
    takeStartupNotice(): Promise<StartupNotice | null>
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
  /** 示例数据：1 = 内置的合成示例卷，不参与真实数据的统计 */
  is_sample?: number
  /** 失败的技术详情（给管理员看，界面收在「查看详情」里） */
  error_detail?: string | null
  /** 疑似重复 / 部分重复：suspect = 默认不计入统计；accepted = 老师确认是新卷 */
  similar_state?: 'suspect' | 'accepted' | null
  similar_to?: string | null
  similar_ratio?: number | null
  /** 像是哪份卷子的一部分（标题） */
  similar_title?: string | null
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
  /** 输出上限「自动」（默认）：按所选模型取默认值，换模型自动跟着变 */
  max_tokens_auto: boolean
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
  /** 每个模型的档案：是不是推理模型、默认输出上限、天花板 */
  profiles: Record<string, ModelProfile>
}
interface ModelProfile { reasoning: boolean; defaultMaxTokens: number; ceiling: number }
type ReportReader = 'boss' | 'parent' | 'teacher' | 'full'

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
  /** 只在 questions.update 的返回值里有：这次修改带来的、要明确告诉老师的变化 */
  notices?: { reopened: boolean; droppedSecondary: string[]; /** 和 droppedSecondary 一一对应的白话名称（永远不含内部代码）：提示里只写它 */ droppedSecondaryNames: string[] }
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
  /** 同类题标注不一致的提示（题目 id → 一句话）：标「需要核对」，不计入「需关注」 */
  hints: Record<string, string>
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
  /** 白话释义（一句话说清考什么）、例句（英文里用 ** 标出关键词）、中文意思、例词 */
  plain?: string | null
  example_en?: string | null
  example_zh?: string | null
  hint_words?: string | null
}

interface KpPlainInput { plain?: string | null; example_en?: string | null; example_zh?: string | null; hint_words?: string | null }
type TaxonomyOpInput =
  | ({ op: 'add'; parent_code: string | null; name: string; note?: string; intro_grade?: number | null } & KpPlainInput)
  | ({ op: 'update'; code: string; name?: string; note?: string | null; intro_grade?: number | null } & KpPlainInput)
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

/** 单个考点的分析范围：从同比页打开时带 target / base，否则只讲筛选范围里的情况 */
interface KpScope {
  filter: StatsFilter
  code: string
  target?: number | null
  base?: 'before' | number | null
  align?: boolean
}

/** 单个考点分析的状态（ai.kpAnalysis）：和同比分析一样，多一个白话考点名 */
interface KpAnalysisState extends Omit<AnalysisState, 'promptVersion'> { name: string }

interface AnalysisState {
  status: 'none' | 'fresh' | 'stale'
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
  model: string | null
  createdAt: string | null
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  /** 事实核对里没对上证据的句子（正文里已标「未核实」） */
  unverified: UnverifiedItem[]
  /** 上次生成失败留下的「未完成草稿」：可以看，不是有效结果 */
  draft: { markdown: string; refs: Array<CitationRef & { missing?: boolean }>; message: string; detail: string; createdAt: string } | null
  /** AI 生成的内容统一带「AI 草稿 · 请老师核对」：恒为 true */
  aiDraft: true
  blocked: string | null
  aiReady: boolean
  promptVersion: string
}
interface UnverifiedItem { sentence: string; kind: 'unverified' | 'conflict'; reason: string; /** 老师在核对框里勾过「已确认无误」（留痕；没勾的不带这个字段） */ acknowledged?: boolean }

interface AnalysisResult {
  ok: boolean
  cancelled?: boolean
  code?: string
  message?: string
  /** 技术详情（给管理员看，收在「查看详情」里） */
  detail?: string
  partial?: string
  markdown?: string
  refs?: CitationRef[]
  warnings?: string[]
}

type ChunkEvent =
  | { id: string; type: 'start'; scopeKey: string; refs: CitationRef[] }
  | { id: string; type: 'delta'; text: string }
  | { id: string; type: 'reset' }
  /** 推理模型正在「思考」（还没开始写正文）：seconds = 本次请求已用秒数，chars = 已思考的字数 */
  | { id: string; type: 'thinking'; seconds: number; chars: number }
  /** 写不完，已把上限加大自动重试（不需要用户操作） */
  | { id: string; type: 'retry'; reason: 'length' }
  | { id: string; type: 'done'; markdown: string; refs: CitationRef[]; warnings: string[]; reportId?: string; unverified?: UnverifiedItem[] }
  | { id: string; type: 'error'; code: string; message: string; detail?: string; partial: string }
  | { id: string; type: 'cancelled'; partial: string }

// ── M4：报告与数据 ──
interface ReportItem {
  id: string
  title: string
  createdAt: string
  model: string | null
  filter: StatsFilter
  filterDesc: string
  /** 读者版本：boss 老板版 / parent 家长版 / teacher 老师版 / full 完整数据版 */
  reader: ReportReader
  readerLabel: string
  /** 恒为 true：AI 生成的内容统一带「AI 草稿 · 请老师核对」；老师点「我已核对」后 confirmedAt 有值 */
  aiDraft: true
  confirmedAt: string | null
  /** 家长版必须先核对才能导出 / 复制 */
  needsConfirm: boolean
  unverifiedCount: number
  /** 非空 = 现在不能导出 / 复制 / 确认的原因（家长版内容太少、还有矛盾句），界面置灰并显示这句话 */
  blockReason: string | null
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
  unverified: UnverifiedItem[]
}
interface ReportPreview {
  filterDesc: string
  papers: number
  questions: number
  blocked: string | null
  aiReady: boolean
  busy: boolean
  reader: ReportReader
  /** 上次生成失败时留下的「未完成草稿」（这个筛选、这个版本）：可以看，不是有效结果 */
  draft: { markdown: string; refs: Array<CitationRef & { missing?: boolean }>; message: string; detail: string; createdAt: string } | null
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
}
interface StartupNotice { kind: 'recovered' | 'completed' | 'failed'; message: string }

declare module '*?raw' {
  const content: string
  export default content
}
