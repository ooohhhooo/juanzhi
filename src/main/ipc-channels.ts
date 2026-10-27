/**
 * 主进程 IPC 通道的分类（不依赖 electron，单测可直接导入）。
 * 每个 ipcMain.handle 的通道必须出现在 WRITE_CHANNELS 或 READONLY_CHANNELS 之一（tests/unit/ipc-guard-audit.test.mjs 扫源码核对），
 * 新增通道忘了分类，单测就会失败（M4 复审 P2-3：当初漏掉 settings:set / data:pickPack）。
 */
/**
 * 写进库 / 文件目录的请求（需要重启时一律拦截）。
 * 全部通道逐个核对过（M4 复审 P2-3、M5 小项）：其余不在表里的通道要么只读（*:get/list/state/tree/info/…、stats:*、report:preview/export 只写用户选的文件），
 * 要么只改内存状态（ai:cancel、parse:cancel、queue:pause、app:takeStartupNotice），要么是界面动作（dialog:openFiles、settings:openDataDir、data:openBackup、app:restart）。
 * 注意 ai:test 不是只读：它会发一次连通测试请求，**并往 ai_usage 表写一行用量记录**（成功失败都记），所以归写入类——重启待定时不能再往旧数据目录写。
 * tests/unit/ipc-guard-audit 会列出 ipcMain.handle 的全部通道，要求每个通道要么在 WRITE_CHANNELS，要么在 READONLY_CHANNELS 里。
 */
export const WRITE_CHANNELS = new Set([
  'papers:import', 'papers:update', 'papers:remove', 'papers:reprocess', 'papers:acceptSimilar', 'papers:scanSimilar',
  'parse:start', 'queue:resume',
  'questions:update', 'questions:remove', 'questions:split', 'questions:merge', 'questions:confirmPaper', 'questions:reopen',
  'taxonomy:save', 'taxonomy:approveSuggestion', 'taxonomy:rejectSuggestion',
  'ai:saveConfig', 'ai:savePrompt', 'ai:resetPrompt', 'ai:analyzeCompare', 'ai:analyzeKp', 'ai:test',   // ai:test 会写 ai_usage（见上）
   'report:generate', 'report:delete', 'report:confirm', 'report:removeSentence',   // report:confirm 写 reports.confirmed_at
  'settings:set',   // 写 settings 表（默认教材、界面状态、引导完成……）
  'data:pickPack',  // 解包到旧数据目录的 .import-staging 里
  'data:importPack', 'data:loadSample', 'data:clearSample', 'data:changeDir', 'data:resetDir', 'data:deleteBackup'
])
/** 导出数据包期间不能让试卷文件被改写的请求（会重新提取 / 重新解析 / 新导入试卷） */
export const EXPORT_BLOCKED = new Set(['papers:import', 'papers:reprocess', 'papers:remove', 'parse:start', 'queue:resume', 'data:importPack', 'data:loadSample', 'data:clearSample', 'data:changeDir'])


/** 只读 / 只改内存状态 / 纯界面动作的通道：重启待定时不拦 */
export const READONLY_CHANNELS = new Set([
  'papers:scanSimilarStatus', 'ai:kpAnalysis', 'ai:cancel', 'ai:compareAnalysis', 'ai:getConfig', 'ai:presets', 'ai:modelProfile', 'ai:prompts', 'ai:usage',
  'app:info', 'app:restart', 'app:takeStartupNotice', 'dialog:openFiles', 'ocr:status',
  'data:chooseDir', 'data:discardPack', 'data:exportPack', 'data:info', 'data:openBackup', 'data:sampleStatus',
  'papers:assets', 'papers:get', 'papers:list', 'papers:pages', 'parse:cancel',
  'questions:list', 'questions:summary', 'queue:pause', 'queue:state',
  'report:export', 'report:get', 'report:list', 'report:preview', 'report:copyWechat', 'report:reveal',   // copyWechat 只写系统剪贴板；reveal 只在文件管理器里显示
  'settings:get', 'settings:getDataDir', 'settings:openDataDir',
  'stats:compare', 'stats:distribution', 'stats:exportMatrix', 'stats:filterOptions', 'stats:hot', 'stats:matrix', 'stats:notes', 'stats:overview', 'stats:questions',
  'taxonomy:tree'
])
