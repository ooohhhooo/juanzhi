// M4 端到端入口：AI 报告页（P3）与导出、数据包导出 / 导入、更改数据目录、示例数据、首次启动引导、知识点树编辑。
// 用法：npm run test:e2e:m4   （需在沙箱外运行：Vision OCR、本地端口与 Electron 都被沙箱限制）
// 调试：EWB_E2E_ONLY=phaseReport,phaseExport 只跑指定阶段（仍先做 phaseSetup，但后面的阶段依赖前面的数据）。正式验证一律不设
const M = require('./m4-lib.cjs')
const R = require('./m4-phases-report.cjs')
const D = require('./m4-phases-data.cjs')
const X = require('./m4-phases-more.cjs')
const Tx = require('./m4-phases-tax.cjs')
const { L, ctx, path } = M

// 顺序有依赖：报告（A）→ 导出 → 数据包（A 导出，B 导入）→ 数据目录（B）→ 示例数据（B）→ 知识点树 / 收尾（B）→ 首次启动（全新 S）
const ALL = [R.phaseReport, R.phaseExport, D.phasePack, X.phaseDataDir, X.phaseSample, Tx.phaseTaxonomy, Tx.phaseMisc, X.phaseOnboarding]

async function main() {
  const only = process.env.EWB_E2E_ONLY?.split(',')
  await R.phaseSetup()
  for (const fn of ALL) if (!only || only.includes(fn.name)) await fn()
}

const dumpFailure = async () => {
  try {
    const f = path.join(M.work, 'failure.png')
    await ctx.page.screenshot({ path: f })
    console.error('失败现场截图：', f)
    console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800))
  } catch { /* 应用可能已退出 */ }
}
const out = path.join(__dirname, 'last-result-m4.json')
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  await dumpFailure()
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 1)
})
