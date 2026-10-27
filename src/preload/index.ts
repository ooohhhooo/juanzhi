import { contextBridge, ipcRenderer, webUtils } from 'electron'

const ALLOWED_CHANNELS = ['data:changed', 'job:progress', 'ai:chunk', 'data:progress', 'similar:progress']

const api = {
  // 对真实 File 对象取路径，并向主进程登记：导入只接受登记过的路径（页面脚本伪造不了 File 的真实路径）
  getPathForFile: (file: File): string => {
    const p = webUtils.getPathForFile(file)
    if (p) ipcRenderer.send('paths:register', p)
    return p
  },
  papers: {
    import: (paths: string[], opts?: { allowDuplicates?: string[] }): Promise<any[]> =>
      ipcRenderer.invoke('papers:import', paths, opts),
    assets: (paperId: string): Promise<any[]> =>
      ipcRenderer.invoke('papers:assets', paperId),
    reprocess: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:reprocess', id),
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
    get: (id: string): Promise<any> =>
      ipcRenderer.invoke('papers:get', id),
    update: (id: string, meta: Record<string, unknown>): Promise<any> =>
      ipcRenderer.invoke('papers:update', id, meta),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('papers:remove', id),
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
    saveConfig: (cfg: Record<string, unknown>, apiKey?: string | null): Promise<any> =>
      apiKey === undefined ? ipcRenderer.invoke('ai:saveConfig', cfg) : ipcRenderer.invoke('ai:saveConfig', cfg, apiKey),
    test: (req: { kind: 'text' | 'vision'; cfg?: Record<string, unknown>; apiKey?: string }): Promise<any> => ipcRenderer.invoke('ai:test', req),
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
  report: {
    list: (): Promise<any[]> => ipcRenderer.invoke('report:list'),
    get: (id: string): Promise<any> => ipcRenderer.invoke('report:get', id),
    preview: (filter?: Record<string, unknown>, reader?: string): Promise<any> => ipcRenderer.invoke('report:preview', filter, reader),
    // 流式增量走 ai:chunk（只发给发起请求的窗口）；取消用 ai.cancel(requestId)。reader：boss / parent / teacher / full（默认 full）
    generate: (filter: Record<string, unknown> | undefined, requestId: string, reader?: string): Promise<any> => ipcRenderer.invoke('report:generate', filter, requestId, reader),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('report:delete', id),
    export: (id: string, fmt: 'md' | 'pdf' | 'docx'): Promise<any> => ipcRenderer.invoke('report:export', id, fmt),
    // 老师点「我已核对」（家长版必须先核对才能导出 / 复制）
    /** 「我已核对」。家长版必须带上 acknowledged = 老师勾了「已确认无误」的未核实句子（原文）：每句「未核实」的话要么已删掉、要么在这个列表里，否则 reject（白话 message）；有矛盾句 / 内容太少也 reject */
    confirm: (id: string, acknowledged?: string[]): Promise<boolean> => ipcRenderer.invoke('report:confirm', id, acknowledged ?? []),
    /** 核对时从报告里删掉清单里的一句「未核实 / 矛盾」的话（正文里连标记一起删）；已核对的报告不能再改。返回更新后的报告 */
    removeSentence: (id: string, sentence: string): Promise<any> => ipcRenderer.invoke('report:removeSentence', id, sentence),
    // 复制到微信：纯文本写进系统剪贴板
    copyWechat: (id: string): Promise<{ text: string; chars: number }> => ipcRenderer.invoke('report:copyWechat', id),
    // 在文件夹里显示刚导出的文件
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('report:reveal', path),
  },
  data: {
    info: (): Promise<any> => ipcRenderer.invoke('data:info'),
    exportPack: (): Promise<any> => ipcRenderer.invoke('data:exportPack'),
    pickPack: (): Promise<any> => ipcRenderer.invoke('data:pickPack'),
    importPack: (token: string, mode: 'merge' | 'overwrite'): Promise<any> => ipcRenderer.invoke('data:importPack', token, mode),
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
  app: {
    info: (): Promise<any> => ipcRenderer.invoke('app:info'),
    restart: (): Promise<boolean> => ipcRenderer.invoke('app:restart'),
    takeStartupNotice: (): Promise<{ kind: 'recovered' | 'completed' | 'failed'; message: string } | null> => ipcRenderer.invoke('app:takeStartupNotice'),
  },
  parse: {
    start: (paperId: string, stage?: 'extract' | 'ai' | 'locate'): Promise<boolean> => ipcRenderer.invoke('parse:start', paperId, stage),
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
    tree: (opts?: { includeDeprecated?: boolean }): Promise<any> => (opts ? ipcRenderer.invoke('taxonomy:tree', opts) : ipcRenderer.invoke('taxonomy:tree')),
    save: (ops: Array<Record<string, unknown>>): Promise<{ ops: number; touched: string[] }> => ipcRenderer.invoke('taxonomy:save', ops),
    approveSuggestion: (questionId: string, body: { parent_code: string | null; name: string }): Promise<string> =>
      ipcRenderer.invoke('taxonomy:approveSuggestion', questionId, body),
    rejectSuggestion: (questionId: string): Promise<boolean> => ipcRenderer.invoke('taxonomy:rejectSuggestion', questionId),
  },
  ocr: {
    status: (): Promise<{ available: boolean; detail: string; lang?: string }> =>
      ipcRenderer.invoke('ocr:status'),
  },
  dialog: {
    openFiles: (): Promise<string[]> =>
      ipcRenderer.invoke('dialog:openFiles'),
  },
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
