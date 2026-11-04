// 交互界面（juanzhi 不带参数 / juanzhi chat）的测试工具：在伪终端里启动程序，用 @xterm/headless 还原屏幕。
//   const t = startTui({ ud, cols: 100, rows: 40 })
//   await t.waitFor(/卷知/); t.send('你好\r'); t.screen() → 当前整屏文字（含滚出视口的历史）
// 伪终端由 tests/e2e/pty-run.py 提供（仓库里没有 node-pty）。仅 Mac / Linux。
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { Terminal } = require('@xterm/headless')
const root = path.resolve(__dirname, '../..')
const electronBin = require(path.join(root, 'node_modules/electron'))

const cleanEnv = extra => {
  const e = { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...extra }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'NO_COLOR', 'ELECTRON_RUN_AS_NODE']) delete e[k]
  if (extra && extra.NO_COLOR !== undefined) e.NO_COLOR = extra.NO_COLOR
  return e
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** bin：改用别的可执行文件（比如模拟打包后的 Electron.app，没有应用目录参数） */
function startTui({ ud, cols = 100, rows = 40, env = {}, args = [], bin = null }) {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  const p = spawn('python3', [path.join(__dirname, 'pty-run.py'), String(cols), String(rows), ...(bin ? [bin] : [electronBin, root]), 'cli', ...args], { env: cleanEnv({ EWB_USER_DATA_DIR: ud, ...env }), cwd: root })
  let raw = '', exited = null
  p.stdout.on('data', d => { raw += d.toString('utf8'); term.write(d) })
  p.stderr.on('data', () => undefined)
  const done = new Promise(res => p.on('close', code => { exited = code; res(code) }))
  const lines = () => {
    const b = term.buffer.active
    const out = []
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true))
    while (out.length && !out[out.length - 1].trim()) out.pop()
    return out
  }
  const t = {
    term, raw: () => raw, exited: () => exited, done,
    screen: () => lines().join('\n'),
    send: s => { try { p.stdin.write(s) } catch { /* 已退出 */ } },
    /** 逐字发送（输入框是按键事件驱动的，一次发一长串会被当成粘贴） */
    type: async (s, gap = 8) => { for (const ch of s) { t.send(ch); await sleep(gap) } },
    async waitFor(re, ms = 20000) {
      const t0 = Date.now()
      for (;;) {
        await sleep(60)
        await new Promise(r => term.write('', r))   // 等 xterm 处理完已收到的数据
        const s = t.screen()
        if (typeof re === 'string' ? s.includes(re) : re.test(s)) return s
        if (exited !== null && Date.now() - t0 > 300) throw new Error(`进程已退出（${exited}），屏幕上没等到 ${re}\n${s}`)
        if (Date.now() - t0 > ms) throw new Error(`等 ${re} 超时\n${s}`)
      }
    },
    async waitExit(ms = 20000) { return Promise.race([done, sleep(ms).then(() => { throw new Error('等退出超时\n' + t.screen()) })]) },
    kill: () => { try { p.kill('SIGKILL') } catch { /* 已经退出 */ } },
    /** 屏幕转 HTML（带颜色），截图用 */
    html() {
      const b = term.buffer.active
      const cell = b.getNullCell()
      const rowsHtml = []
      let last = b.length - 1
      while (last > 0 && !b.getLine(last).translateToString(true).trim()) last--
      for (let y = 0; y <= last; y++) {
        const line = b.getLine(y)
        let html = ''
        for (let x = 0; x < term.cols; x++) {
          const c = line.getCell(x, cell)
          if (!c || c.getWidth() === 0) continue
          let ch = c.getChars() || ' '
          const fg = c.isFgRGB() ? '#' + c.getFgColor().toString(16).padStart(6, '0') : c.isFgPalette() ? 'p' + c.getFgColor() : ''
          const bg = c.isBgRGB() ? '#' + c.getBgColor().toString(16).padStart(6, '0') : c.isBgPalette() ? 'p' + c.getBgColor() : ''
          const st = []
          const col = v => (v.startsWith('#') ? v : PALETTE[Number(v.slice(1))] || '')
          let f = fg ? col(fg) : '', g = bg ? col(bg) : ''
          if (c.isInverse()) { const x2 = f || '#e6e6f0'; f = g || '#16161d'; g = x2 }
          if (f) st.push(`color:${f}`)
          if (g) st.push(`background:${g}`)
          if (c.isBold()) st.push('font-weight:700')
          if (c.isDim()) st.push('opacity:.55')
          if (c.isItalic()) st.push('font-style:italic')
          ch = ch.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          // 全角字占两格：固定宽度，右边的框线才对得齐（字体回退时中文字宽不一定正好是两个半角）
          if (c.getWidth() === 2) st.push('display:inline-block;width:2ch;overflow:hidden;vertical-align:bottom')
          html += st.length ? `<span style="${st.join(';')}">${ch}</span>` : ch
        }
        rowsHtml.push(html)
      }
      return rowsHtml.join('\n')
    }
  }
  return t
}

const PALETTE = ['#16161d', '#e0566a', '#5ec27a', '#e0b84a', '#6d8ff0', '#c06ee0', '#4ec9d8', '#d0d0dc', '#5a5a6a', '#ff7a8c', '#7ee89a', '#ffd666', '#8fb0ff', '#df8cff', '#7ae6f2', '#ffffff']

/** 屏幕 HTML 包成一页（深色终端样式），给 Playwright 截图 */
function htmlPage(inner, title = '') {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;background:#16161d"><div style="padding:18px 22px"><pre style="margin:0;font:15px/1.35 'SF Mono',Menlo,'PingFang SC',monospace;color:#e6e6f0;white-space:pre">${inner}</pre></div></body>`
}

module.exports = { startTui, htmlPage, sleep, root, electronBin, cleanEnv, fs }
