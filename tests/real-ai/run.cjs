// 真实 API 冒烟：设置环境变量 EWB_REAL_AI_KEY 后，对 samples/g4-2026.pdf 做一次真实解析，把模型的原始请求/响应存到 tests/real-ai/raw/（已 gitignore）。
// 没设置 EWB_REAL_AI_KEY 时只打印说明并退出（退出码 0），不会访问网络。
//
//   EWB_REAL_AI_KEY=sk-... npm run test:real-ai
// 可选：EWB_REAL_AI_PROVIDER（deepseek|qwen|doubao|kimi|zhipu，默认 deepseek）、EWB_REAL_AI_BASE_URL、EWB_REAL_AI_MODEL、EWB_REAL_AI_VISION_MODEL
//
// 说明：本脚本写好后在 M2 阶段没有真实密钥可用，**从未运行过**；运行时请在沙箱外（要访问外网并启动 Electron）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('../e2e/lib.cjs')

const key = process.env.EWB_REAL_AI_KEY
if (!key) {
  console.log('未设置 EWB_REAL_AI_KEY，跳过真实 API 测试。用法见本文件开头的注释。')
  process.exit(0)
}

async function main() {
  // 预设直接读应用里的那份（providers.ts），不再在这里复制一份；需要 node --experimental-strip-types（npm run test:real-ai 已带）
  const { PROVIDER_PRESETS } = await import('../../src/main/ai/providers.ts')
  const provider = process.env.EWB_REAL_AI_PROVIDER || 'deepseek'
  const preset = PROVIDER_PRESETS.find(p => p.id === provider && p.id !== 'custom')
  // 未知服务商必须报错退出：悄悄回退到别家，会把这把密钥发到不对的主机
  if (!preset) {
    console.error(`未知的 EWB_REAL_AI_PROVIDER=${provider}。可选：${PROVIDER_PRESETS.filter(p => p.id !== 'custom').map(p => p.id).join(' / ')}（用别的服务请同时设置 EWB_REAL_AI_BASE_URL，并把 provider 设成最接近的预设）`)
    process.exit(2)
  }
  const [baseUrl, model, vision] = [preset.baseUrl, preset.model, preset.visionModel]
  const cfg = {
    provider, base_url: process.env.EWB_REAL_AI_BASE_URL || baseUrl, model: process.env.EWB_REAL_AI_MODEL || model,
    vision_model: process.env.EWB_REAL_AI_VISION_MODEL || vision, concurrency: 1, auto_parse: false, batch_pages: 3, timeout_sec: 300, max_tokens: 8192
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(__dirname, 'raw', stamp)
  fs.mkdirSync(outDir, { recursive: true })
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-real-'))
  // 主进程会把每次调用的 messages 与原始 content 写进这个目录（图片 base64 省略，不含密钥）
  const { app, page } = await L.launch({ userDataDir: ud, extraEnv: { EWB_AI_DUMP_DIR: outDir } })
  try {
    await page.evaluate(([c, k]) => window.api.ai.saveConfig(c, k), [cfg, key])
    const t = await page.evaluate(() => window.api.ai.test({ kind: 'text' }))
    console.log('连接测试：', t.ok ? '成功' : '失败', t.message)
    if (!t.ok) throw new Error('连接测试失败，请检查密钥、Base URL 与模型名')

    await L.dropFiles(page, [path.resolve(__dirname, '../../samples/g4-2026.pdf')])
    const extracted = await L.waitStatus(page, 'g4-2026.pdf', ['extracted', 'failed'], 120000)
    if (!extracted || extracted.status !== 'extracted') throw new Error('提取失败：' + extracted?.error)
    const t0 = Date.now()
    await page.evaluate(id => window.api.parse.start(id), extracted.id)
    const done = await L.waitStatus(page, 'g4-2026.pdf', ['reviewing', 'failed'], 15 * 60 * 1000)
    const list = await page.evaluate(id => window.api.questions.list(id), extracted.id)
    const usage = await page.evaluate(id => window.api.ai.usage(id), extracted.id)
    const qs = list.questions
    const kpIssues = qs.filter(q => q.flags.includes('kp_invalid') || q.flags.includes('kp_uncertain')).length
    const summary = {
      provider, model: cfg.model, status: done?.status, error: done?.error, seconds: Math.round((Date.now() - t0) / 1000),
      questions: qs.length, located: qs.filter(q => q.bbox).length, lowConfidence: qs.filter(q => q.confidence < 0.7).length, kpIssues,
      suggestions: qs.filter(q => q.kp_suggestion).length, flags: [...new Set(qs.flatMap(q => q.flags))], usage, promptVersion: list.run?.prompt_version, notes: list.notes
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(qs, null, 2))
    console.log(JSON.stringify(summary, null, 2))
    console.log(`原始请求/响应与结果已保存到 ${outDir}`)
    process.exitCode = done?.status === 'reviewing' ? 0 : 1
  } finally {
    await app.close()
    // 临时数据目录里有加密后的密钥和试卷副本，用完就删（原始请求/响应已另存在 raw/ 里）
    fs.rmSync(ud, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exit(1) })
