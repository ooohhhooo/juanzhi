import { contextBridge, ipcRenderer, webUtils } from 'electron'

const ALLOWED_CHANNELS = ['data:changed', 'job:progress']

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
    // 只能拿到 hasKey，拿不到密钥本身；密钥只能写入（apiKey 省略 = 不改，null = 清除）
    getConfig: (): Promise<any> => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (cfg: Record<string, unknown>, apiKey?: string | null): Promise<any> =>
      apiKey === undefined ? ipcRenderer.invoke('ai:saveConfig', cfg) : ipcRenderer.invoke('ai:saveConfig', cfg, apiKey),
    test: (req: { kind: 'text' | 'vision'; cfg?: Record<string, unknown>; apiKey?: string }): Promise<any> => ipcRenderer.invoke('ai:test', req),
    prompts: (): Promise<any> => ipcRenderer.invoke('ai:prompts'),
    savePrompt: (id: string, part: string, text: string): Promise<boolean> => ipcRenderer.invoke('ai:savePrompt', id, part, text),
    resetPrompt: (id: string, part: string): Promise<boolean> => ipcRenderer.invoke('ai:resetPrompt', id, part),
    usage: (paperId?: string): Promise<any[]> => (paperId ? ipcRenderer.invoke('ai:usage', paperId) : ipcRenderer.invoke('ai:usage')),
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
    tree: (): Promise<any> => ipcRenderer.invoke('taxonomy:tree'),
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
