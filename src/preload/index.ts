import { contextBridge, ipcRenderer, webUtils } from 'electron'

const ALLOWED_CHANNELS = ['data:changed', 'job:progress', 'ai:chunk', 'data:progress', 'similar:progress', 'update:state', 'course:progress', 'datasets:progress', 'menu:navigate', 'agent-outputs:changed', 'agent:event']

const api = {
  // 对真实 File 对象取路径，并向主进程登记：导入只接受登记过的路径（页面脚本伪造不了 File 的真实路径）
  getPathForFile: (file: File): string => {
    const p = webUtils.getPathForFile(file)
    if (p) ipcRenderer.send('paths:register', p)
    return p
  },
  papers: {
    import: (paths: string[], opts?: { allowDuplicates?: string[]; subject?: string }): Promise<any[]> =>
      ipcRenderer.invoke('papers:import', paths, opts),
    /** 把拖入 / 选择的路径展开：文件夹递归找出里面支持的试卷文件（跳过隐藏文件），返回要导入的文件和被跳过的 */
    expandPaths: (paths: string[]): Promise<{ files: string[]; folders: number; skipped: Array<{ name: string; reason: string }>; skippedMore: number; truncated: boolean }> =>
      ipcRenderer.invoke('papers:expandPaths', paths),
    assets: (paperId: string): Promise<any[]> =>
      ipcRenderer.invoke('papers:assets', paperId),
    reprocess: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:reprocess', id),
    /** 提醒里选了学科（放到X / 保持X）：设学科、清建议，然后照常解析 */
    resolveSubject: (id: string, subject: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:resolveSubject', id, subject),
    /** 改学科：删旧题目、按新学科重新识别；已审核的先返回 { needConfirm: true, reviewed }，带 confirmLoseReview 再调一次才真改 */
    setSubject: (id: string, subject: string, opts?: { confirmLoseReview?: boolean }): Promise<{ needConfirm: true; reviewed: number } | { needConfirm: false; changed: boolean; reparse: boolean }> =>
      ipcRenderer.invoke('papers:setSubject', id, subject, opts),
    acceptSimilar: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:acceptSimilar', id),
    /** 「检查重复试卷」：后台扫描，结束时才 resolve（按钮据此显示「检查中」）；进度见事件 `similar:progress`（{ running, done, total, suspects? }） */
    scanSimilar: (): Promise<{ checked: number; suspects: number }> =>
      ipcRenderer.invoke('papers:scanSimilar'),
    /** 当前扫描状态（页面刷新后恢复「检查中」用） */
    scanSimilarStatus: (): Promise<{ running: boolean; done: number; total: number; suspects: number | null }> =>
      ipcRenderer.invoke('papers:scanSimilarStatus'),
    list: (filter?: Record<string, unknown>): Promise<any[]> =>
      ipcRenderer.invoke('papers:list', filter),
    diag: (id: string): Promise<any> => ipcRenderer.invoke('papers:diag', id),
    get: (id: string): Promise<any> =>
      ipcRenderer.invoke('papers:get', id),
    update: (id: string, meta: Record<string, unknown>): Promise<any> =>
      ipcRenderer.invoke('papers:update', id, meta),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:remove', id),
    /** 批量：一次调用，主进程逐份处理，返回每份的结果（ok / 跳过原因） */
    batchUpdate: (ids: string[], meta: Record<string, unknown>): Promise<Array<{ id: string; ok: boolean; reason?: string }>> =>
      ipcRenderer.invoke('papers:batchUpdate', ids, meta),
    batchRemove: (ids: string[]): Promise<Array<{ id: string; ok: boolean; reason?: string }>> =>
      ipcRenderer.invoke('papers:batchRemove', ids),
    pages: (paperId: string): Promise<any[]> =>
      ipcRenderer.invoke('papers:pages', paperId),
  },
  settings: {
    get: (key: string): Promise<unknown> =>
      ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown): Promise<boolean> =>
      ipcRenderer.invoke('settings:set', key, value),
    getDataDir: (): Promise<string> =>
      ipcRenderer.invoke('settings:getDataDir'),
    openDataDir: (): Promise<boolean> =>
      ipcRenderer.invoke('settings:openDataDir'),
  },
  ai: {
    presets: (): Promise<any[]> => ipcRenderer.invoke('ai:presets'),
    modelProfile: (model: string): Promise<any> => ipcRenderer.invoke('ai:modelProfile', model),
    // 只能拿到 hasKey，拿不到密钥本身；密钥只能写入（apiKey 省略 = 不改，null = 清除）
    getConfig: (): Promise<any> => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (cfg: Record<string, unknown>, apiKey?: string | null, visionKey?: string | null): Promise<any> =>
      visionKey !== undefined ? ipcRenderer.invoke('ai:saveConfig', cfg, apiKey === undefined ? undefined : apiKey, visionKey)
        : apiKey === undefined ? ipcRenderer.invoke('ai:saveConfig', cfg) : ipcRenderer.invoke('ai:saveConfig', cfg, apiKey),
    test: (req: { kind: 'text' | 'vision'; cfg?: Record<string, unknown>; apiKey?: string; visionKey?: string }): Promise<any> => ipcRenderer.invoke('ai:test', req),
    testAll: (req: { cfg?: Record<string, unknown>; apiKey?: string; visionKey?: string }): Promise<any> => ipcRenderer.invoke('ai:testAll', req),
    modelHint: (): Promise<any> => ipcRenderer.invoke('ai:modelHint'),
    dismissModelHint: (): Promise<boolean> => ipcRenderer.invoke('ai:dismissModelHint'),
    prompts: (): Promise<any> => ipcRenderer.invoke('ai:prompts'),
    savePrompt: (id: string, part: string, text: string): Promise<boolean> => ipcRenderer.invoke('ai:savePrompt', id, part, text),
    resetPrompt: (id: string, part: string): Promise<boolean> => ipcRenderer.invoke('ai:resetPrompt', id, part),
    usage: (paperId?: string): Promise<any[]> => (paperId ? ipcRenderer.invoke('ai:usage', paperId) : ipcRenderer.invoke('ai:usage')),
    // P2 同比分析：compareAnalysis 只读缓存状态（不花钱）；analyzeCompare 流式生成，增量走 ai:chunk 事件（只发给发起请求的窗口）
    compareAnalysis: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('ai:compareAnalysis', scope),
    analyzeCompare: (scope: Record<string, unknown>, requestId: string): Promise<any> => ipcRenderer.invoke('ai:analyzeCompare', scope, requestId),
    /** 看板抽屉里「只讲这一个考点」的 AI 分析。scope = { filter, code, target?, base?, align? }：从同比页打开时带 target（今年）和 base（'before' 或某一学年），否则只讲筛选范围内的情况。kpAnalysis 只读状态（不花钱）；analyzeKp 流式生成（ai:chunk，ai.cancel 取消），≤ 250 字、很快 */
    kpAnalysis: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('ai:kpAnalysis', scope),
    analyzeKp: (scope: Record<string, unknown>, requestId: string): Promise<any> => ipcRenderer.invoke('ai:analyzeKp', scope, requestId),
    cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke('ai:cancel', requestId),
    balance: (force?: boolean): Promise<any> => ipcRenderer.invoke('ai:balance', force === true),
    openConsole: (which?: 'text' | 'vision'): Promise<boolean> => ipcRenderer.invoke('ai:openConsole', which),
    getCustomBalance: (): Promise<any> => ipcRenderer.invoke('ai:getCustomBalance'),
    setCustomBalance: (c: { url: string; balancePath: string; totalPath: string; unit: string }): Promise<any> => ipcRenderer.invoke('ai:setCustomBalance', c),
    diagnose: (a: { message?: string; task?: string }): Promise<any> => ipcRenderer.invoke('ai:diagnose', a),
    getPrices: (): Promise<any> => ipcRenderer.invoke('ai:getPrices'),
    setPrices: (p: Array<{ model: string; inPer1M: number | null; outPer1M: number | null; cachedInPer1M: number | null }>): Promise<any> => ipcRenderer.invoke('ai:setPrices', p),
    costEstimate: (a: { task: string; calls: number; fallbackTokens?: number }): Promise<any> => ipcRenderer.invoke('ai:costEstimate', a),
    lastSpend: (): Promise<any[]> => ipcRenderer.invoke('ai:lastSpend'),
    usageByKind: (): Promise<any> => ipcRenderer.invoke('ai:usageByKind'),
  },
  stats: {
    overview: (filter?: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('stats:overview', filter),
    distribution: (filter?: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('stats:distribution', filter),
    matrix: (filter: Record<string, unknown> | undefined, level: number): Promise<any> => ipcRenderer.invoke('stats:matrix', filter, level),
    hot: (filter: Record<string, unknown> | undefined, level: number): Promise<any> => ipcRenderer.invoke('stats:hot', filter, level),
    compare: (filter: Record<string, unknown> | undefined, target: number, base: 'before' | number, level?: number, align?: boolean): Promise<any> => ipcRenderer.invoke('stats:compare', filter, target, base, level, align),
    notes: (filter?: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('stats:notes', filter),
    questions: (filter: Record<string, unknown> | undefined, side: Record<string, unknown>, code: string, limit?: number): Promise<any[]> => ipcRenderer.invoke('stats:questions', filter, side, code, limit),
    filterOptions: (filter?: Record<string, unknown>): Promise<any> => (filter === undefined ? ipcRenderer.invoke('stats:filterOptions') : ipcRenderer.invoke('stats:filterOptions', filter)),
    exportMatrix: (filter: Record<string, unknown> | undefined, level: number): Promise<{ saved: boolean; path?: string; bytes?: number }> => ipcRenderer.invoke('stats:exportMatrix', filter, level),
  },
  analysisReport: {
    export: (spec: unknown, format: 'xlsx' | 'html' | 'docx'): Promise<{ saved: boolean; path?: string; bytes?: number }> => ipcRenderer.invoke('analysisReport:export', spec, format),
    exportTable: (columns: unknown[], rows: unknown[], sheetName?: string): Promise<{ saved: boolean; path?: string; bytes?: number }> => ipcRenderer.invoke('analysisReport:exportTable', columns, rows, sheetName)
  },
  report: {
    list: (subject?: string): Promise<any[]> => ipcRenderer.invoke('report:list', subject),
    get: (id: string): Promise<any> => ipcRenderer.invoke('report:get', id),
    preview: (filter?: Record<string, unknown>, reader?: string): Promise<any> => ipcRenderer.invoke('report:preview', filter, reader),
    // 流式增量走 ai:chunk（只发给发起请求的窗口）；取消用 ai.cancel(requestId)。reader：boss / parent / teacher / full（默认 full）
    generate: (filter: Record<string, unknown> | undefined, requestId: string, reader?: string, options?: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('report:generate', filter, requestId, reader, options),
    retryPart: (id: string, part: string, requestId: string): Promise<any> => ipcRenderer.invoke('report:retryPart', id, part, requestId),
    variantTick: (id: string, variantId: string, ok: boolean): Promise<any> => ipcRenderer.invoke('report:variantTick', id, variantId, ok),
    cardImage: (id: string, kind: string, index: number, mode: string, templateId?: string): Promise<any> => ipcRenderer.invoke('report:cardImage', id, kind, index, mode, templateId),
    cardTemplates: (): Promise<any> => ipcRenderer.invoke('report:cardTemplates'),
    parentCardPlan: (id: string): Promise<any> => ipcRenderer.invoke('report:parentCardPlan', id),
    parentCard: (id: string, mode: string, templateId?: string): Promise<any> => ipcRenderer.invoke('report:parentCard', id, mode, templateId),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('report:delete', id),
    export: (id: string, fmt: 'md' | 'pdf' | 'docx'): Promise<any> => ipcRenderer.invoke('report:export', id, fmt),
    // 老师点「我已核对」（家长版必须先核对才能导出 / 复制）
    /** 「我已核对」。家长版必须带上 acknowledged = 老师勾了「已确认无误」的未核实句子（原文）：每句「未核实」的话要么已删掉、要么在这个列表里，否则 reject（白话 message）；有矛盾句 / 内容太少也 reject */
    confirm: (id: string, acknowledged?: string[]): Promise<boolean> => ipcRenderer.invoke('report:confirm', id, acknowledged ?? []),
    /** 核对时从报告里删掉清单里的一句「未核实 / 矛盾」的话（正文里连标记一起删）；已核对的报告不能再改。返回更新后的报告 */
    removeSentence: (id: string, sentence: string): Promise<any> => ipcRenderer.invoke('report:removeSentence', id, sentence),
    // 复制到微信：纯文本写进系统剪贴板
    copyCourseAdvice: (id: string): Promise<{ text: string; chars: number }> => ipcRenderer.invoke('report:copyCourseAdvice', id),
    copyWechat: (id: string): Promise<{ text: string; chars: number }> => ipcRenderer.invoke('report:copyWechat', id),
    // 在文件夹里显示刚导出的文件
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('report:reveal', path),
  },
  data: {
    info: (): Promise<any> => ipcRenderer.invoke('data:info'),
    exportPack: (opts?: { withCourse?: boolean }): Promise<any> => ipcRenderer.invoke('data:exportPack', opts),
    pickPack: (): Promise<any> => ipcRenderer.invoke('data:pickPack'),
    importPack: (token: string, mode: 'merge' | 'overwrite', opts?: { updateCourses?: boolean }): Promise<any> => ipcRenderer.invoke('data:importPack', token, mode, opts),
    discardPack: (token: string): Promise<boolean> => ipcRenderer.invoke('data:discardPack', token),
    deleteBackup: (name: string): Promise<boolean> => ipcRenderer.invoke('data:deleteBackup', name),
    openBackup: (name: string): Promise<boolean> => ipcRenderer.invoke('data:openBackup', name),
    chooseDir: (): Promise<any> => ipcRenderer.invoke('data:chooseDir'),
    changeDir: (token: string, mode: 'move' | 'use'): Promise<any> => ipcRenderer.invoke('data:changeDir', token, mode),
    resetDir: (): Promise<any> => ipcRenderer.invoke('data:resetDir'),
    sampleStatus: (): Promise<{ loaded: boolean; papers: number; questions: number }> => ipcRenderer.invoke('data:sampleStatus'),
    loadSample: (): Promise<any> => ipcRenderer.invoke('data:loadSample'),
    clearSample: (): Promise<any> => ipcRenderer.invoke('data:clearSample'),
  },
  /** 内置助手：角色、历史会话、提问（过程走 agent:event 事件）、停止、回答提问、同意 / 拒绝写操作 */
  agent: {
    roles: (): Promise<any> => ipcRenderer.invoke('agent:roles'),
    status: (model?: string): Promise<any> => ipcRenderer.invoke('agent:status', model),
    models: (): Promise<any[]> => ipcRenderer.invoke('agent:models'),
    modelInfo: (model: string): Promise<any> => ipcRenderer.invoke('agent:modelInfo', model),
    tools: (): Promise<any[]> => ipcRenderer.invoke('agent:tools'),
    customRoles: (): Promise<any[]> => ipcRenderer.invoke('agent:customRoles'),
    settings: (): Promise<any> => ipcRenderer.invoke('agent:settings'),
    saveSettings: (p: { orgContext?: string; contextLimit?: number | null }): Promise<any> => ipcRenderer.invoke('agent:saveSettings', p),
    saveRole: (r: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('agent:saveRole', r),
    roleDraft: (reqId: string, answers: { job: string; tasks: string[]; reportTo: string; style: string; extra: string }): Promise<any> => ipcRenderer.invoke('agent:roleDraft', { reqId, answers }),
    roleDraftCancel: (reqId: string): Promise<boolean> => ipcRenderer.invoke('agent:roleDraftCancel', reqId),
    deleteRole: (id: string): Promise<boolean> => ipcRenderer.invoke('agent:deleteRole', id),
    importRole: (): Promise<any> => ipcRenderer.invoke('agent:importRole'),
    exportRole: (id: string): Promise<{ saved: boolean; path?: string }> => ipcRenderer.invoke('agent:exportRole', id),
    checkEffort: (model: string): Promise<any> => ipcRenderer.invoke('agent:checkEffort', model),
    playbooks: (): Promise<any> => ipcRenderer.invoke('agent:playbooks'),
    playbookGet: (name: string): Promise<any> => ipcRenderer.invoke('agent:playbookGet', name),
    playbookSave: (p: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('agent:playbookSave', p),
    playbookDelete: (name: string): Promise<boolean> => ipcRenderer.invoke('agent:playbookDelete', name),
    playbookImport: (kind: 'file' | 'folder'): Promise<any> => ipcRenderer.invoke('agent:playbookImport', kind),
    playbookExport: (name: string): Promise<any> => ipcRenderer.invoke('agent:playbookExport', name),
    playbookOpenDir: (): Promise<string> => ipcRenderer.invoke('agent:playbookOpenDir'),
    sessions: (subject?: string): Promise<any[]> => ipcRenderer.invoke('agent:sessions', subject),
    session: (id: string): Promise<any> => ipcRenderer.invoke('agent:session', id),
    cites: (refs: Array<{ kind: string; id: string }>): Promise<any[]> => ipcRenderer.invoke('agent:cites', refs),
    queryRecord: (sessionId: string, n: number): Promise<any> => ipcRenderer.invoke('agent:queryRecord', sessionId, n),
    setScene: (scene: 'org' | 'school'): Promise<'org' | 'school'> => ipcRenderer.invoke('agent:setScene', scene),
    checkTools: (model?: string): Promise<any> => ipcRenderer.invoke('agent:checkTools', model),
    run: (a: Record<string, unknown>): Promise<{ sessionId: string; branchId: string }> => ipcRenderer.invoke('agent:run', a),
    /** 附件（图片 / PDF / Word / 文本）：选择、读文字、读粘贴的截图；返回编号，提问时放在 run 的 attachments 里 */
    pickAttachments: (): Promise<string[]> => ipcRenderer.invoke('agent:pickAttachments'),
    readAttachment: (path: string): Promise<any> => ipcRenderer.invoke('agent:readAttachment', path),
    readPastedImage: (name: string, bytes: Uint8Array): Promise<any> => ipcRenderer.invoke('agent:readPastedImage', name, bytes),
    deleteSession: (id: string): Promise<boolean> => ipcRenderer.invoke('agent:deleteSession', id),
    stop: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('agent:stop', sessionId),
    answer: (sessionId: string, askId: string, answer: string): Promise<boolean> => ipcRenderer.invoke('agent:answer', sessionId, askId, answer),
    approve: (sessionId: string, id: string, ok: boolean): Promise<boolean> => ipcRenderer.invoke('agent:approve', sessionId, id, ok),
  },
  files: {
    /** 统一导入入口：表格进数据，图片进试卷库，pdf / docx 按内容分流；路径必须来自对话框或 getPathForFile */
    importAuto: (paths: string[], currentSubject: string): Promise<any> => ipcRenderer.invoke('files:importAuto', paths, currentSubject)
  },
  datasets: {
    /** 弹对话框选 Excel / CSV，返回路径（已登记） */
    pick: (): Promise<string[]> => ipcRenderer.invoke('datasets:pick'),
    /** 导入若干文件（路径必须来自 pick 或 getPathForFile）；进度见事件 `datasets:progress` */
    import: (paths: string[]): Promise<Array<{ file: string; ok: boolean; id?: string; error?: string }>> => ipcRenderer.invoke('datasets:import', paths),
    list: (): Promise<any[]> => ipcRenderer.invoke('datasets:list'),
    /** 文档资料（图片识别文字、PDF、Word、文本） */
    documents: (): Promise<any[]> => ipcRenderer.invoke('datasets:documents'),
    documentText: (id: string): Promise<string> => ipcRenderer.invoke('datasets:documentText', id),
    removeDocument: (id: string): Promise<boolean> => ipcRenderer.invoke('datasets:removeDocument', id),
    setDocumentSubject: (id: string, subject: string): Promise<boolean> => ipcRenderer.invoke('datasets:setDocumentSubject', id, subject),
    setDatasetSubject: (id: string, subject: string): Promise<boolean> => ipcRenderer.invoke('datasets:setDatasetSubject', id, subject),
    /** 卷知里其他数据的数量：试卷、课程大纲、报告 */
    sources: (): Promise<{ papers: number; outlines: number; reports: number }> => ipcRenderer.invoke('datasets:sources'),
    profile: (id: string): Promise<any> => ipcRenderer.invoke('datasets:profile', id),
    profileText: (id: string, table?: string): Promise<string> => ipcRenderer.invoke('datasets:profileText', id, table),
    /** 前 100 行预览（界面显示真名） */
    preview: (id: string, table: string): Promise<{ columns: Array<{ name: string; label: string; type: string; sensitive: boolean }>; rows: unknown[][]; total: number }> => ipcRenderer.invoke('datasets:preview', id, table),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('datasets:remove', id),
    setSensitive: (id: string, table: string, column: string, sensitive: boolean): Promise<boolean> => ipcRenderer.invoke('datasets:setSensitive', id, table, column, sensitive),
    rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('datasets:rename', id, name),
    setNote: (id: string, note: string): Promise<boolean> => ipcRenderer.invoke('datasets:setNote', id, note)
  },
  /** 课程对照：上传向导、课程体系管理、知识点对应、看板「课程对照」页签、家长沟通建议 */
  course: {
    list: (subject?: string): Promise<any[]> => ipcRenderer.invoke('course:list', subject),
    get: (id: string): Promise<any> => ipcRenderer.invoke('course:get', id),
    maps: (id: string): Promise<any[]> => ipcRenderer.invoke('course:maps', id),
    search: (outlineIds: string[], q: string): Promise<any[]> => ipcRenderer.invoke('course:search', outlineIds, q),
    setActive: (id: string, active: boolean): Promise<boolean> => ipcRenderer.invoke('course:setActive', id, active),
    rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('course:rename', id, name),
    confirmDraft: (id: string): Promise<boolean> => ipcRenderer.invoke('course:confirmDraft', id),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('course:remove', id),
    pickFile: (): Promise<any> => ipcRenderer.invoke('course:pickFile'),
    readFile: (path: string): Promise<any> => ipcRenderer.invoke('course:readFile', path),
    readText: (text: string): Promise<any> => ipcRenderer.invoke('course:readText', text),
    suggest: (req: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:suggest', req),
    jobStart: (items: Array<Record<string, unknown>>): Promise<any[]> => ipcRenderer.invoke('course:jobStart', items),
    jobs: (): Promise<any[]> => ipcRenderer.invoke('course:jobs'),
    jobTake: (id: string): Promise<any> => ipcRenderer.invoke('course:jobTake', id),
    jobCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('course:jobCancel', id),
    jobRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('course:jobRemove', id),
    jobRetry: (id: string): Promise<boolean> => ipcRenderer.invoke('course:jobRetry', id),
    suggestCancel: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('course:suggestCancel', sessionId),
    preview: (req: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:preview', req),
    diff: (req: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:diff', req),
    save: (req: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:save', req),
    template: (kind: 'blank' | 'sample', subject?: string): Promise<any> => ipcRenderer.invoke('course:template', kind, subject),
    matchEstimate: (id: string, onlyNew: boolean): Promise<any> => ipcRenderer.invoke('course:matchEstimate', id, onlyNew),
    matchProgress: (id: string): Promise<any> => ipcRenderer.invoke('course:matchProgress', id),
    matchCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('course:matchCancel', id),
    match: (id: string, onlyNew: boolean): Promise<any> => ipcRenderer.invoke('course:match', id, onlyNew),
    mapEdit: (edit: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('course:mapEdit', edit),
    dashboard: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:dashboard', scope),
    exportGaps: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:exportGaps', scope),
    adviceState: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:adviceState', scope),
    adviceGenerate: (scope: Record<string, unknown>, requestId: string): Promise<any> => ipcRenderer.invoke('course:adviceGenerate', scope, requestId),
    adviceConfirm: (scope: Record<string, unknown>, acknowledged?: string[]): Promise<any> => ipcRenderer.invoke('course:adviceConfirm', scope, acknowledged ?? []),
    adviceCopy: (scope: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('course:adviceCopy', scope),
  },
  app: {
    info: (): Promise<any> => ipcRenderer.invoke('app:info'),
    restart: (): Promise<boolean> => ipcRenderer.invoke('app:restart'),
    takeStartupNotice: (): Promise<{ kind: 'recovered' | 'completed' | 'failed'; message: string } | null> => ipcRenderer.invoke('app:takeStartupNotice'),
  },
  parse: {
    start: (paperId: string, stage?: 'extract' | 'ai' | 'locate'): Promise<boolean> => ipcRenderer.invoke('parse:start', paperId, stage),
    batchStart: (ids: string[]): Promise<Array<{ id: string; ok: boolean; reason?: string }>> => ipcRenderer.invoke('parse:batchStart', ids),
    cancel: (paperId: string): Promise<boolean> => ipcRenderer.invoke('parse:cancel', paperId),
  },
  queue: {
    state: (): Promise<any> => ipcRenderer.invoke('queue:state'),
    pause: (): Promise<boolean> => ipcRenderer.invoke('queue:pause'),
    resume: (): Promise<boolean> => ipcRenderer.invoke('queue:resume'),
  },
  questions: {
    list: (paperId: string): Promise<any> => ipcRenderer.invoke('questions:list', paperId),
    summary: (): Promise<any[]> => ipcRenderer.invoke('questions:summary'),
    update: (id: string, patch: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('questions:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('questions:remove', id),
    split: (id: string, body: Record<string, unknown>): Promise<string> => ipcRenderer.invoke('questions:split', id, body),
    merge: (id: string): Promise<boolean> => ipcRenderer.invoke('questions:merge', id),
    confirmPaper: (paperId: string, markAll: boolean): Promise<boolean> => ipcRenderer.invoke('questions:confirmPaper', paperId, markAll),
    reopen: (paperId: string): Promise<boolean> => ipcRenderer.invoke('questions:reopen', paperId),
  },
  taxonomy: {
    tree: (opts?: { includeDeprecated?: boolean; subject?: string }): Promise<any> => (opts ? ipcRenderer.invoke('taxonomy:tree', opts) : ipcRenderer.invoke('taxonomy:tree')),
    save: (ops: Array<Record<string, unknown>>): Promise<{ ops: number; touched: string[] }> => ipcRenderer.invoke('taxonomy:save', ops),
    approveSuggestion: (questionId: string, body: { parent_code: string | null; name: string }): Promise<string> =>
      ipcRenderer.invoke('taxonomy:approveSuggestion', questionId, body),
    rejectSuggestion: (questionId: string): Promise<boolean> => ipcRenderer.invoke('taxonomy:rejectSuggestion', questionId),
  },
  os: {
    openLanguageSettings: (): Promise<boolean> => ipcRenderer.invoke('os:openLanguageSettings'),
    openOcrTutorial: (): Promise<boolean> => ipcRenderer.invoke('os:openOcrTutorial'),
  },
  ocr: {
    status: (): Promise<{ available: boolean; detail: string; lang?: string }> =>
      ipcRenderer.invoke('ocr:status'),
  },
  /** 连接器：企业微信群、MCP 服务器的配置 / 测试 / 允许的工具 */
  connectors: {
    types: (): Promise<any[]> => ipcRenderer.invoke('connectors:types'),
    list: (): Promise<any[]> => ipcRenderer.invoke('connectors:list'),
    save: (req: { id?: string; type: string; name: string; config: Record<string, unknown> }): Promise<any> => ipcRenderer.invoke('connectors:save', req),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('connectors:remove', id),
    test: (id: string): Promise<any> => ipcRenderer.invoke('connectors:test', id),
    setAllowed: (id: string, names: string[]): Promise<any> => ipcRenderer.invoke('connectors:setAllowed', id, names),
    openShimo: (): Promise<boolean> => ipcRenderer.invoke('connectors:openShimo'),
    /** 用浏览器打开某个预设的文档页（只认预设编号，不接受任意网址） */
    openDocs: (presetId: string): Promise<boolean> => ipcRenderer.invoke('connectors:openDocs', presetId),
    /** 弹系统文件框选一个要发出的文件（选中即记一次性发送许可），返回路径；取消返回 null */
    pickSendFile: (): Promise<string | null> => ipcRenderer.invoke('connectors:pickSendFile'),
  },
  /** 命令行工具（短命令 juanzhi）：看装没装、安装 */
  cli: {
    status: (): Promise<{ supported: boolean; packaged: boolean; portable: boolean; installed: boolean; path: string; dir: string; exePath: string }> =>
      ipcRenderer.invoke('cli:status'),
    install: (): Promise<{ ok: boolean; platform: string; path: string; dir: string; onPath: boolean; hint: string; warnings: string[] }> =>
      ipcRenderer.invoke('cli:install'),
  },
  /** 应用内更新：state 当前状态；check 检查（silent = 静默）；download 下载并校验；install 退出并替换（有任务在跑会返回 busy，force 放弃任务） */
  update: {
    state: (): Promise<any> => ipcRenderer.invoke('update:state'),
    check: (silent?: boolean): Promise<any> => ipcRenderer.invoke('update:check', { silent: !!silent }),
    download: (): Promise<any> => ipcRenderer.invoke('update:download'),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('update:cancel'),
    install: (force?: boolean): Promise<{ ok: boolean; busy?: string; hard?: boolean; message?: string }> => ipcRenderer.invoke('update:install', { force: !!force }),
    skip: (version: string): Promise<boolean> => ipcRenderer.invoke('update:skip', version),
    openReleasePage: (): Promise<boolean> => ipcRenderer.invoke('update:openReleasePage'),
  },
  dialog: {
    openFiles: (): Promise<string[]> =>
      ipcRenderer.invoke('dialog:openFiles'),
    openFolder: (): Promise<string[]> =>
      ipcRenderer.invoke('dialog:openFolder'),
  },
  /** 诊断信息：preview 先看里面有什么，export 选位置保存 zip（不含学生数据和密钥）；short = 5 行简短诊断 */
  diagnostics: {
    preview: (): Promise<{ entries: Array<{ name: string; desc: string; bytes: number }>; totalBytes: number; neverIncluded: string[] }> => ipcRenderer.invoke('diagnostics:preview'),
    export: (): Promise<{ saved: boolean; path?: string; dir?: string; bytes?: number; files?: number }> => ipcRenderer.invoke('diagnostics:export'),
    short: (copy?: boolean): Promise<string> => ipcRenderer.invoke('diagnostics:short', copy === true),
  },
  /** 助手会话的产出（汇报文档、名单表格、看板登记）；变化事件见 window.api.on('agent-outputs:changed')，参数是 sessionId */
  agentOutputs: {
    list: (sessionId: string): Promise<any[]> => ipcRenderer.invoke('agent-outputs:list', sessionId),
    read: (sessionId: string, id: string): Promise<any> => ipcRenderer.invoke('agent-outputs:read', sessionId, id),
    board: (sessionId: string): Promise<any> => ipcRenderer.invoke('agent-outputs:board', sessionId),
    export: (sessionId: string, id: string, format: 'docx' | 'pdf' | 'xlsx' | 'csv' | 'md'): Promise<any> => ipcRenderer.invoke('agent-outputs:export', sessionId, id, format),
    reveal: (sessionId: string, id: string): Promise<boolean> => ipcRenderer.invoke('agent-outputs:reveal', sessionId, id),
    copyImage: (sessionId: string, id: string): Promise<boolean> => ipcRenderer.invoke('agent-outputs:copyImage', sessionId, id),
    rerenderCard: (sessionId: string, id: string, templateId: string): Promise<{ templateId: string; templateName: string }> => ipcRenderer.invoke('agent-outputs:rerenderCard', sessionId, id, templateId),
    saveImage: (sessionId: string, id: string): Promise<{ saved: boolean; path?: string }> => ipcRenderer.invoke('agent-outputs:saveImage', sessionId, id),
  },
  /** 分享卡片：模板列表（含默认 / 孩子称呼设置）、示例预览、改默认模板、改孩子称呼 */
  cards: {
    templates: (): Promise<any> => ipcRenderer.invoke('cards:templates'),
    preview: (id: string, thumb: boolean, kind?: string, subject?: string): Promise<string> => ipcRenderer.invoke('cards:preview', id, thumb, kind, subject),
    setDefault: (audience: 'student' | 'parent', id: string): Promise<any> => ipcRenderer.invoke('cards:setDefault', audience, id),
    setChildName: (mode: 'first' | 'none'): Promise<any> => ipcRenderer.invoke('cards:setChildName', mode),
  },
  /** 反馈问题：打开 GitHub 新建 Issue 页（预填版本、系统；地址由主进程生成） */
  feedback: {
    url: (): Promise<string> => ipcRenderer.invoke('feedback:url'),
    open: (): Promise<boolean> => ipcRenderer.invoke('feedback:open'),
  },
  /** 渲染端错误上报到运行日志（主进程限速） */
  logError: (msg: string): void => { ipcRenderer.send('log:renderer', String(msg).slice(0, 300)) },
  on: (channel: string, callback: (...args: any[]) => void): (() => void) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      console.warn(`[preload] 不允许订阅通道: ${channel}`)
      return () => {}
    }
    const handler = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  }
}

contextBridge.exposeInMainWorld('api', api)
