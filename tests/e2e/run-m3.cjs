// M3 端到端入口：分析看板。阶段分布在 m3-phases-ui.cjs（筛选/分布/同比/抽屉）和 m3-phases-ai.cjs（P2 流式、缓存、实时更新、IPC 校验）。
// 用法：npm run test:e2e:m3   （需在沙箱外运行：Vision OCR 与本地端口监听都被沙箱限制）
// 调试：EWB_E2E_ONLY=phaseOverview,phaseRestart 只跑指定阶段（仍先做 phaseSetup）。正式验证一律不设
const U = require('./m3-phases-ui.cjs')
let A = {}
try { A = require('./m3-phases-ai.cjs') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }
const L = require('./lib.cjs')

const ALL = [U.phaseOverview, U.phaseRestart, U.phaseDistribution, U.phaseCompare, U.phaseDrawer, ...(A.phases ?? [])]

async function main() {
  const only = process.env.EWB_E2E_ONLY?.split(',')
  await U.phaseSetup()
  for (const fn of ALL) if (!only || only.includes(fn.name)) await fn()
}

const dumpFailure = async () => {
  try {
    const f = require('node:path').join(U.work, 'failure.png')
    await U.ctx.page.screenshot({ path: f })
    console.error('失败现场截图：', f)
    console.error('页面控制台错误：', JSON.stringify(U.ctx.consoleErrors ?? []).slice(0, 800))
  } catch { /* 应用可能已退出 */ }
}

main().then(async () => {
  try { await U.ctx.app?.close() } catch { /* 已关闭 */ }
  try { await U.ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(require('node:path').join(__dirname, 'last-result-m3.json')) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  await dumpFailure()
  U.check('E2E', '测试脚本未异常退出', false, e.message)
  process.exit(L.finish(require('node:path').join(__dirname, 'last-result-m3.json')) ? 1 : 1)
})
