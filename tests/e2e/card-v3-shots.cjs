// 看卡片版式用：6 种 kind 各用一套模板渲染一张，再把 20 套模板各渲染一张（学生 knowledge / 家长 weekly），存到截图目录，人工逐张看有没有溢出。
// 用法：EWB_SHOTS=<目录> node tests/e2e/card-v3-shots.cjs   （沙箱外；先 electron-vite build）
const M = require('./m4-lib.cjs')
const { check, fs, path, work, ctx, open, closeApp, L, goto } = M
const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

const render = (id, kind) => ctx.page.evaluate(async ([i, k]) => {
  const url = await window.api.cards.preview(i, false, k)
  const img = new Image(); img.src = url; await img.decode()
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
  c.getContext('2d').drawImage(img, 0, 0)
  return c.toDataURL('image/png')
}, [id, kind])
const save = (name, dataUrl) => fs.writeFileSync(path.join(SHOTS, name), Buffer.from(dataUrl.split(',')[1], 'base64'))

async function main() {
  await open(path.join(work, 'userShots'), {})
  await goto('#/assistant')
  const plan = [['stu-a', 'knowledge'], ['stu-a02', 'mnemonic'], ['stu-a03', 'practice'], ['par-e', 'weekly'], ['par-e02', 'progress'], ['par-e03', 'brief']]
  for (const [id, kind] of plan) {
    try { save(`card-v3-${kind}-${id}.png`, await render(id, kind)); check('版式', `${id} ${kind} 渲染成功`, true) } catch (e) { check('版式', `${id} ${kind} 渲染成功`, false, String(e.message).slice(0, 200)) }
  }
  const t = await ctx.page.evaluate(() => window.api.cards.templates())
  for (const x of [...t.student, ...t.parent]) {
    const kind = t.student.includes(x) ? 'knowledge' : 'weekly'
    try { save(`card-v3-all-${x.id}.png`, await render(x.id, kind)); check('全部模板', `${x.id} 渲染成功`, true) } catch (e) { check('全部模板', `${x.id} 渲染成功`, false, String(e.message).slice(0, 200)) }
  }
  await closeApp()
}
main().then(() => process.exit(L.finish(path.join(__dirname, 'last-result-cards.json')) ? 1 : 0)).catch(async e => { console.error(e); try { await closeApp() } catch { /* 忽略 */ } process.exit(1) })
