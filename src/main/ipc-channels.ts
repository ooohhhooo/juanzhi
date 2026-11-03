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
  'papers:import', 'papers:update', 'papers:remove', 'papers:batchUpdate', 'papers:batchRemove', 'papers:reprocess', 'papers:acceptSimilar', 'papers:scanSimilar',
  'parse:start', 'parse:batchStart', 'queue:resume',
  'questions:update', 'questions:remove', 'questions:split', 'questions:merge', 'questions:confirmPaper', 'questions:reopen',
  'taxonomy:save', 'taxonomy:approveSuggestion', 'taxonomy:rejectSuggestion',
  'ai:saveConfig', 'ai:setPrices', 'ai:setCustomBalance', 'ai:savePrompt', 'ai:resetPrompt', 'ai:analyzeCompare', 'ai:analyzeKp', 'ai:test', 'ai:testAll', 'ai:dismissModelHint',   // ai:test 会写 ai_usage（见上）
   'report:generate', 'report:delete', 'report:confirm', 'report:removeSentence', 'report:retryPart', 'report:variantTick',   // report:confirm 写 reports.confirmed_at
  'settings:set',   // 写 settings 表（默认教材、界面状态、引导完成……）
  'data:pickPack',  // 解包到旧数据目录的 .import-staging 里
  'data:importPack', 'data:loadSample', 'data:clearSample', 'data:changeDir', 'data:resetDir', 'data:deleteBackup',
  // 课程对照（beta.2）：写课程表、匹配结果、话术缓存；course:suggest / course:match / course:adviceGenerate 会调用 AI 并写 ai_usage，所以归写入类
  'course:setActive', 'course:rename', 'course:confirmDraft', 'course:remove', 'course:suggest', 'course:save', 'course:jobStart', 'course:match', 'course:mapEdit', 'course:adviceGenerate', 'course:adviceConfirm',
  // 数据集（分析 Agent 的数据底座）：导入 / 删除 / 改标记 / 改名 / 备注都写 <数据目录>/datasets/
  'datasets:import', 'datasets:remove', 'datasets:setSensitive', 'datasets:rename', 'datasets:setNote'
])
/** 导出数据包期间不能让试卷文件被改写的请求（会重新提取 / 重新解析 / 新导入试卷） */
export const EXPORT_BLOCKED = new Set(['papers:import', 'papers:reprocess', 'papers:remove', 'papers:batchRemove', 'parse:start', 'parse:batchStart', 'queue:resume', 'data:importPack', 'data:loadSample', 'data:clearSample', 'data:changeDir'])


/** 只读 / 只改内存状态 / 纯界面动作的通道：重启待定时不拦 */
export const READONLY_CHANNELS = new Set([
  'papers:scanSimilarStatus', 'ai:kpAnalysis', 'ai:cancel', 'ai:compareAnalysis', 'ai:getConfig', 'ai:presets', 'ai:modelProfile', 'ai:prompts', 'ai:usage', 'ai:modelHint', 'ai:balance', 'ai:openConsole', 'ai:getPrices', 'ai:getCustomBalance', 'ai:diagnose', 'ai:costEstimate', 'ai:lastSpend', 'ai:usageByKind', 'papers:diag', 'os:openLanguageSettings', 'os:openOcrTutorial',
  'papers:expandPaths', 'dialog:openFolder', 'diagnostics:preview', 'diagnostics:export', 'diagnostics:short', 'feedback:url', 'feedback:open',
  'app:info', 'app:restart', 'app:takeStartupNotice', 'dialog:openFiles', 'ocr:status',
  'data:chooseDir', 'data:discardPack', 'data:exportPack', 'data:info', 'data:openBackup', 'data:sampleStatus',
  'papers:assets', 'papers:get', 'papers:list', 'papers:pages', 'parse:cancel',
  'questions:list', 'questions:summary', 'queue:pause', 'queue:state',
  'report:export', 'report:get', 'report:list', 'report:preview', 'report:copyWechat', 'report:copyCourseAdvice', 'report:reveal', 'report:cardImage',   // copyWechat 只写系统剪贴板；reveal 只在文件管理器里显示；cardImage 只写剪贴板或用户在「另存为」里选的文件
  'settings:get', 'settings:getDataDir', 'settings:openDataDir',
  'stats:compare', 'stats:distribution', 'stats:exportMatrix', 'stats:filterOptions', 'stats:hot', 'stats:matrix', 'stats:notes', 'stats:overview', 'stats:questions',
  'taxonomy:tree',
  'update:state', 'update:check', 'update:download', 'update:cancel', 'update:install', 'update:skip', 'update:openReleasePage',   // 应用内更新：只写临时目录和一个小状态文件，不动数据
  // 课程对照的读取类：列表 / 详情 / 看板 / 状态；pickFile、readFile、readText 只读用户选的文件到内存；template、exportGaps 只写用户选的位置；adviceCopy 只写剪贴板；matchCancel 只改内存
  'course:list', 'course:get', 'course:maps', 'course:search', 'course:pickFile', 'course:readFile', 'course:readText', 'course:preview', 'course:diff', 'course:template',
  'course:suggestCancel', 'course:jobs', 'course:jobTake', 'course:jobCancel', 'course:jobRemove', 'course:jobRetry', 'course:matchEstimate', 'course:matchProgress', 'course:matchCancel', 'course:dashboard', 'course:exportGaps', 'course:adviceState', 'course:adviceCopy',
  // 数据集的读取类：pick 只弹对话框；list / profile / preview / profileText 只读
  'datasets:pick', 'datasets:list', 'datasets:profile', 'datasets:preview', 'datasets:profileText',
  'cli:status', 'cli:install'   // 只写 ~/.local/bin 或用户目录下的包装脚本（和数据目录无关），重启待定时也可以用
])
