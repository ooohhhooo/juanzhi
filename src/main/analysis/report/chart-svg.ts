/**
 * 图表渲染：纯函数「图表规格 → SVG 字符串」。渲染端（dangerouslySetInnerHTML）和网页导出共用同一套，所以两边看到的一样。
 * 颜色全部走 CSS 类和 CSS 变量（--rb-*），由外层页面定义（渲染端映射到设计 token，网页导出自带浅色 / 深色两套），SVG 里没有写死的颜色。
 * 悬停提示用每个图形里的 <title>（原生 tooltip，导出的网页里也能用），悬停高亮用 CSS。
 * 宽度自适应：只设 viewBox，外层 width:100%，窄窗口整体缩小不溢出。
 */
import { formatValue, type Chart, type ValueFormat } from './spec.ts'

export const SERIES_COUNT = 8

/** 图表用到的类，外层页面把它放进 <style>；变量见 chartVarsLight / chartVarsDark */
export const CHART_CSS = `
.rb-chart{display:block;width:100%;height:auto;max-width:100%;overflow:visible;font-family:inherit}
.rb-chart text{font-size:12px;fill:var(--rb-ink2);font-variant-numeric:tabular-nums}
.rb-chart .rb-val{font-size:11px;fill:var(--rb-ink)}
.rb-chart .rb-in{fill:var(--rb-onbar);font-size:11px}
.rb-chart .rb-leg{fill:var(--rb-ink)}
.rb-chart .rb-grid{stroke:var(--rb-line);stroke-width:1}
.rb-chart .rb-axis{stroke:var(--rb-line-strong);stroke-width:1}
.rb-chart .rb-m{transition:opacity .12s}
.rb-chart .rb-m:hover{opacity:.78}
.rb-chart .rb-gap{stroke:var(--rb-page);stroke-width:1.5}
.rb-chart .rb-ring{fill:var(--rb-page)}
${Array.from({ length: SERIES_COUNT }, (_, i) => `.rb-chart .rb-f${i}{fill:var(--rb-s${i})}.rb-chart .rb-k${i}{stroke:var(--rb-s${i});fill:none}`).join('')}
.rb-chart .rb-heat text{fill:var(--rb-ink)}
`

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const escXml = (s: string): string => s.replace(/[&<>"]/g, c => ESC[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** 文字宽度估算（12px）：汉字 12，其余 6.8 */
export function textWidth(s: string, size = 12): number {
  let w = 0
  for (const ch of s) w += (ch.charCodeAt(0) > 255 ? 1 : 0.57) * size
  return w
}
function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s
}

/** 取整刻度：返回 [min, max, step] */
export function niceScale(lo: number, hi: number, ticks = 4): { min: number; max: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 0.25 }
  if (hi === lo) { hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.5); }
  const raw = (hi - lo) / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const min = Math.floor(lo / step + 1e-9) * step
  const max = Math.ceil(hi / step - 1e-9) * step
  return { min, max, step }
}
function tickList(s: { min: number; max: number; step: number }): number[] {
  const out: number[] = []
  for (let v = s.min; v <= s.max + s.step * 1e-6; v += s.step) out.push(Math.round(v / s.step) * s.step)
  return out
}

const r1 = (n: number): string => String(Math.round(n * 10) / 10)
const ci = (i: number): number => i % SERIES_COUNT

interface Legend { svg: string; height: number }
function legend(names: string[], width: number, x0 = 0): Legend {
  if (names.length < 2) return { svg: '', height: 0 }
  let x = x0, y = 10
  const parts: string[] = []
  names.forEach((n, i) => {
    const label = clip(n, 14)
    const w = 16 + textWidth(label) + 18
    if (x + w > width && x > x0) { x = x0; y += 20 }
    parts.push(`<g><rect class="rb-f${ci(i)}" x="${r1(x)}" y="${y - 8}" width="10" height="10" rx="2"/><text class="rb-leg" x="${r1(x + 15)}" y="${y + 1}">${escXml(label)}</text></g>`)
    x += w
  })
  return { svg: parts.join(''), height: y + 12 }
}

function wrap(chart: Chart, w: number, h: number, inner: string): string {
  const label = `${chart.title}（${chart.categories.length} 项）`
  return `<svg class="rb-chart" viewBox="0 0 ${r1(w)} ${r1(h)}" role="img" aria-label="${escXml(label)}">${inner}</svg>`
}

function empty(chart: Chart, w: number): string {
  return wrap(chart, w, 80, `<text x="${w / 2}" y="44" text-anchor="middle">没有数据</text>`)
}

const nums = (vs: Array<number | null>): number[] => vs.filter((v): v is number => v !== null && Number.isFinite(v))

export interface SvgOptions { width?: number }

export function renderChartSvg(chart: Chart, opts: SvgOptions = {}): string {
  const W = Math.max(320, opts.width ?? 720)
  const hasData = chart.series.some(s => nums(s.values).length > 0)
  if (!hasData) return empty(chart, W)
  switch (chart.kind) {
    case 'bar': case 'groupedBar': case 'stackedBar': return vertical(chart, W)
    case 'barH': return horizontal(chart, W)
    case 'line': return lineChart(chart, W)
    case 'pie': return pie(chart, W)
    case 'scatter': return scatter(chart, W)
    case 'heatRow': return heat(chart, W)
  }
}

const tip = (cat: string, series: string, v: number | null, f: ValueFormat, extra = ''): string =>
  `<title>${escXml(cat)}${series ? ` · ${escXml(series)}` : ''}：${formatValue(v, f)}${extra}</title>`

// ───────────── 柱状（bar / groupedBar / stackedBar） ─────────────
function vertical(c: Chart, W: number): string {
  const stacked = c.kind === 'stackedBar'
  const n = c.categories.length
  const f = c.valueFormat
  const series = c.kind === 'bar' && c.series.length === 1 ? c.series : c.series
  const leg = legend(series.map(s => s.name), W - 16, 8)
  // 数值范围
  let lo = 0, hi = 0
  for (let i = 0; i < n; i++) {
    if (stacked) hi = Math.max(hi, series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0))
    else for (const s of series) { const v = s.values[i]; if (v !== null && v !== undefined) { hi = Math.max(hi, v); lo = Math.min(lo, v) } }
  }
  const sc = niceScale(lo, hi)
  const ticks = tickList(sc)
  const left = Math.max(...ticks.map(t => textWidth(formatValue(t, f), 12))) + 14
  const right = 12
  const plotW = W - left - right
  const slot = plotW / Math.max(1, n)
  const labels = c.categories.map(s => clip(s, 12))
  const maxLab = Math.max(0, ...labels.map(l => textWidth(l)))
  const rotate = maxLab > slot - 4
  const bottom = rotate ? Math.min(84, maxLab * 0.62 + 16) : 28
  const top = leg.height + 16
  const plotH = 220
  const H = top + plotH + bottom
  const y = (v: number): number => top + plotH - ((v - sc.min) / (sc.max - sc.min)) * plotH
  const parts: string[] = [leg.svg]
  for (const t of ticks) parts.push(`<line class="rb-grid" x1="${r1(left)}" x2="${r1(W - right)}" y1="${r1(y(t))}" y2="${r1(y(t))}"/><text x="${r1(left - 6)}" y="${r1(y(t) + 4)}" text-anchor="end">${escXml(formatValue(t, f))}</text>`)
  parts.push(`<line class="rb-axis" x1="${r1(left)}" x2="${r1(W - right)}" y1="${r1(y(0))}" y2="${r1(y(0))}"/>`)
  const groupW = Math.min(slot * 0.72, 72 * (stacked ? 1 : series.length))
  const k = stacked ? 1 : series.length
  const barW = Math.max(3, (groupW / k) * (k > 1 ? 0.92 : 1))
  const showVal = n * (stacked ? 1 : k) <= 40 && barW >= 14
  for (let i = 0; i < n; i++) {
    const cx = left + slot * (i + 0.5)
    let acc = 0
    series.forEach((s, j) => {
      const v = s.values[i]
      if (v === null || v === undefined) return
      let x: number, y0: number, y1: number
      if (stacked) { x = cx - barW / 2; y0 = y(acc); acc += Math.max(0, v); y1 = y(acc) }
      else { x = cx - groupW / 2 + (groupW / k) * j + (groupW / k - barW) / 2; y0 = y(Math.max(0, 0)); y1 = y(v) }
      const top1 = Math.min(y0, y1), h = Math.max(0.5, Math.abs(y0 - y1))
      parts.push(`<g class="rb-m"><rect class="rb-f${ci(j)}${stacked ? ' rb-gap' : ''}" x="${r1(x)}" y="${r1(top1)}" width="${r1(barW)}" height="${r1(h)}" rx="${stacked ? 0 : 2}"/>${tip(c.categories[i], series.length > 1 ? s.name : '', v, f)}</g>`)
      if (showVal && !stacked) parts.push(`<text class="rb-val" x="${r1(x + barW / 2)}" y="${r1(v >= 0 ? top1 - 4 : top1 + h + 12)}" text-anchor="middle">${escXml(formatValue(v, f))}</text>`)
      else if (showVal && stacked && h >= 15) parts.push(`<text class="rb-in" x="${r1(x + barW / 2)}" y="${r1(top1 + h / 2 + 4)}" text-anchor="middle">${escXml(formatValue(v, f))}</text>`)
    })
    if (stacked && showVal) parts.push(`<text class="rb-val" x="${r1(cx)}" y="${r1(y(acc) - 4)}" text-anchor="middle">${escXml(formatValue(acc, f))}</text>`)
    const lx = cx, ly = top + plotH + 16
    parts.push(rotate
      ? `<text x="${r1(lx)}" y="${r1(ly)}" text-anchor="end" transform="rotate(-35 ${r1(lx)} ${r1(ly)})">${escXml(labels[i])}${c.categories[i] !== labels[i] ? `<title>${escXml(c.categories[i])}</title>` : ''}</text>`
      : `<text x="${r1(lx)}" y="${r1(ly)}" text-anchor="middle">${escXml(labels[i])}${c.categories[i] !== labels[i] ? `<title>${escXml(c.categories[i])}</title>` : ''}</text>`)
  }
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 横向条形 ─────────────
function horizontal(c: Chart, W: number): string {
  const n = c.categories.length
  const f = c.valueFormat
  const k = c.series.length
  const labels = c.categories.map(s => clip(s, 14))
  const left = Math.min(170, Math.max(40, ...labels.map(l => textWidth(l))) + 12)
  const valRoom = 56
  const leg = legend(c.series.map(s => s.name), W - 16, 8)
  const top = leg.height + 8
  const rowH = Math.max(18, k * 16 + 8)
  const plotW = W - left - valRoom
  let hi = 0, lo = 0
  for (const s of c.series) for (const v of nums(s.values)) { hi = Math.max(hi, v); lo = Math.min(lo, v) }
  const sc = niceScale(lo, hi)
  const x = (v: number): number => left + ((v - sc.min) / (sc.max - sc.min)) * plotW
  const H = top + n * rowH + 28
  const parts: string[] = [leg.svg]
  for (const t of tickList(sc)) parts.push(`<line class="rb-grid" x1="${r1(x(t))}" x2="${r1(x(t))}" y1="${top}" y2="${r1(top + n * rowH)}"/><text x="${r1(x(t))}" y="${r1(top + n * rowH + 16)}" text-anchor="middle">${escXml(formatValue(t, f))}</text>`)
  parts.push(`<line class="rb-axis" x1="${r1(x(0))}" x2="${r1(x(0))}" y1="${top}" y2="${r1(top + n * rowH)}"/>`)
  const bh = Math.max(6, Math.min(22, (rowH - 8) / k))
  for (let i = 0; i < n; i++) {
    const cy = top + rowH * i
    parts.push(`<text x="${left - 8}" y="${r1(cy + rowH / 2 + 4)}" text-anchor="end">${escXml(labels[i])}${labels[i] !== c.categories[i] ? `<title>${escXml(c.categories[i])}</title>` : ''}</text>`)
    c.series.forEach((s, j) => {
      const v = s.values[i]
      if (v === null || v === undefined) return
      const by = cy + (rowH - bh * k) / 2 + bh * j
      const x0 = x(0), x1 = x(v)
      parts.push(`<g class="rb-m"><rect class="rb-f${ci(j)}" x="${r1(Math.min(x0, x1))}" y="${r1(by + 1)}" width="${r1(Math.max(0.5, Math.abs(x1 - x0)))}" height="${r1(bh - 2)}" rx="2"/>${tip(c.categories[i], k > 1 ? s.name : '', v, f)}</g>`)
      parts.push(`<text class="rb-val" x="${r1(Math.max(x0, x1) + 5)}" y="${r1(by + bh / 2 + 4)}">${escXml(formatValue(v, f))}</text>`)
    })
  }
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 折线 ─────────────
function lineChart(c: Chart, W: number): string {
  const n = c.categories.length
  const f = c.valueFormat
  const leg = legend(c.series.map(s => s.name), W - 16, 8)
  let lo = Infinity, hi = -Infinity
  for (const s of c.series) for (const v of nums(s.values)) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  lo = Math.min(0, lo)
  const sc = niceScale(lo, hi)
  const ticks = tickList(sc)
  const left = Math.max(...ticks.map(t => textWidth(formatValue(t, f)))) + 14
  const right = 20
  const plotW = W - left - right
  const slot = plotW / Math.max(1, n)
  const labels = c.categories.map(s => clip(s, 10))
  const rotate = Math.max(0, ...labels.map(l => textWidth(l))) > slot - 4
  const bottom = rotate ? Math.min(80, Math.max(...labels.map(l => textWidth(l))) * 0.62 + 16) : 28
  const top = leg.height + 16, plotH = 220
  const H = top + plotH + bottom
  const x = (i: number): number => left + slot * (i + 0.5)
  const y = (v: number): number => top + plotH - ((v - sc.min) / (sc.max - sc.min)) * plotH
  const parts: string[] = [leg.svg]
  for (const t of ticks) parts.push(`<line class="rb-grid" x1="${r1(left)}" x2="${r1(W - right)}" y1="${r1(y(t))}" y2="${r1(y(t))}"/><text x="${r1(left - 6)}" y="${r1(y(t) + 4)}" text-anchor="end">${escXml(formatValue(t, f))}</text>`)
  const showVal = n * c.series.length <= 24
  c.series.forEach((s, j) => {
    let d = ''
    s.values.forEach((v, i) => { if (v === null || !Number.isFinite(v)) { d += ' '; return } d += `${d.trim() === '' || d.endsWith(' ') ? 'M' : 'L'}${r1(x(i))} ${r1(y(v))}` })
    parts.push(`<path class="rb-k${ci(j)}" d="${d.trim()}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`)
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return
      parts.push(`<g class="rb-m"><circle class="rb-f${ci(j)}" cx="${r1(x(i))}" cy="${r1(y(v))}" r="3.6"/>${tip(c.categories[i], c.series.length > 1 ? s.name : '', v, f)}</g>`)
      if (showVal) parts.push(`<text class="rb-val" x="${r1(x(i))}" y="${r1(y(v) - 8)}" text-anchor="middle">${escXml(formatValue(v, f))}</text>`)
    })
  })
  labels.forEach((l, i) => {
    const lx = x(i), ly = top + plotH + 16
    parts.push(`<text x="${r1(lx)}" y="${r1(ly)}" text-anchor="${rotate ? 'end' : 'middle'}"${rotate ? ` transform="rotate(-35 ${r1(lx)} ${r1(ly)})"` : ''}>${escXml(l)}</text>`)
  })
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 饼（环形） ─────────────
function pie(c: Chart, W: number): string {
  const s = c.series[0]
  const f = c.valueFormat
  const items = c.categories.map((cat, i) => ({ cat, v: Math.max(0, s.values[i] ?? 0), i })).filter(d => d.v > 0)
  const total = items.reduce((a, d) => a + d.v, 0)
  if (!total) return empty(c, W)
  const R = 92, r = 54
  const cx = 8 + R + 6, cy = 12 + R
  const parts: string[] = []
  let a0 = -Math.PI / 2
  const pt = (rad: number, a: number): string => `${r1(cx + rad * Math.cos(a))} ${r1(cy + rad * Math.sin(a))}`
  for (const d of items) {
    const frac = d.v / total
    const a1 = a0 + frac * Math.PI * 2
    const share = `${formatValue(frac, 'percent')}`
    const title = `<title>${escXml(d.cat)}：${formatValue(d.v, f)}（占 ${share}）</title>`
    if (frac > 0.9999) parts.push(`<g class="rb-m"><circle class="rb-f${ci(d.i)}" cx="${cx}" cy="${cy}" r="${R}"/><circle class="rb-ring" cx="${cx}" cy="${cy}" r="${r}"/>${title}</g>`)
    else {
      const large = a1 - a0 > Math.PI ? 1 : 0
      parts.push(`<g class="rb-m"><path class="rb-f${ci(d.i)} rb-gap" d="M${pt(R, a0)}A${R} ${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r, a1)}A${r} ${r} 0 ${large} 0 ${pt(r, a0)}Z"/>${title}</g>`)
    }
    a0 = a1
  }
  parts.push(`<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="rb-val" style="font-size:16px;font-weight:600">${escXml(formatValue(total, f === 'percent' ? 'number' : f))}</text><text x="${cx}" y="${cy + 15}" text-anchor="middle">合计</text>`)
  // 图例（右侧，每行：色块 名称 数值 占比）
  const lx = cx + R + 28
  const maxRows = 12
  const shown = items.slice(0, maxRows)
  const nameW = Math.max(...shown.map(d => textWidth(clip(d.cat, 12))))
  shown.forEach((d, k) => {
    const yy = 22 + k * 20
    parts.push(`<rect class="rb-f${ci(d.i)}" x="${lx}" y="${yy - 9}" width="10" height="10" rx="2"/><text class="rb-leg" x="${lx + 16}" y="${yy}">${escXml(clip(d.cat, 12))}</text><text class="rb-val" x="${r1(lx + 16 + nameW + 14)}" y="${yy}">${escXml(formatValue(d.v, f))} · ${escXml(formatValue(d.v / total, 'percent'))}</text>`)
  })
  if (items.length > maxRows) parts.push(`<text x="${lx}" y="${22 + maxRows * 20}">另有 ${items.length - maxRows} 项</text>`)
  const H = Math.max(2 * R + 24, 22 + Math.min(items.length, maxRows + 1) * 20 + 8)
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 散点 ─────────────
function scatter(c: Chart, W: number): string {
  const f = c.valueFormat
  const xs = c.series[0].values, ys = c.series[1]?.values ?? []
  const pts = xs.map((x, i) => ({ x, y: ys[i], name: c.categories[i] ?? '' })).filter((p): p is { x: number; y: number; name: string } => p.x !== null && p.y !== null && p.y !== undefined)
  if (!pts.length) return empty(c, W)
  const sx = niceScale(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)))
  const sy = niceScale(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)))
  const yt = tickList(sy), xt = tickList(sx)
  const left = Math.max(...yt.map(t => textWidth(formatValue(t, f)))) + 34
  const right = 24, top = 16, plotH = 240, bottom = 44
  const plotW = W - left - right
  const H = top + plotH + bottom
  const X = (v: number): number => left + ((v - sx.min) / (sx.max - sx.min)) * plotW
  const Y = (v: number): number => top + plotH - ((v - sy.min) / (sy.max - sy.min)) * plotH
  const parts: string[] = []
  for (const t of yt) parts.push(`<line class="rb-grid" x1="${r1(left)}" x2="${r1(W - right)}" y1="${r1(Y(t))}" y2="${r1(Y(t))}"/><text x="${r1(left - 6)}" y="${r1(Y(t) + 4)}" text-anchor="end">${escXml(formatValue(t, f))}</text>`)
  for (const t of xt) parts.push(`<line class="rb-grid" x1="${r1(X(t))}" x2="${r1(X(t))}" y1="${top}" y2="${top + plotH}"/><text x="${r1(X(t))}" y="${top + plotH + 16}" text-anchor="middle">${escXml(formatValue(t, f))}</text>`)
  parts.push(`<line class="rb-axis" x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}"/><line class="rb-axis" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"/>`)
  parts.push(`<text x="${r1(left + plotW / 2)}" y="${H - 6}" text-anchor="middle">${escXml(c.series[0].name)}</text>`)
  parts.push(`<text x="12" y="${r1(top + plotH / 2)}" text-anchor="middle" transform="rotate(-90 12 ${r1(top + plotH / 2)})">${escXml(c.series[1]?.name ?? '')}</text>`)
  const showName = pts.length <= 20
  pts.forEach(p => {
    parts.push(`<g class="rb-m"><circle class="rb-f0" cx="${r1(X(p.x))}" cy="${r1(Y(p.y))}" r="5" fill-opacity=".85"/><title>${escXml(p.name)}（${escXml(formatValue(p.x, f))}，${escXml(formatValue(p.y, f))}）</title></g>`)
    if (showName && p.name) parts.push(`<text class="rb-val" x="${r1(X(p.x) + 8)}" y="${r1(Y(p.y) + 4)}">${escXml(clip(p.name, 8))}</text>`)
  })
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 热力行 ─────────────
function heat(c: Chart, W: number): string {
  const n = c.categories.length
  const f = c.valueFormat
  const all = c.series.flatMap(s => nums(s.values))
  const lo = Math.min(...all), hi = Math.max(...all)
  const left = Math.min(150, Math.max(...c.series.map(s => textWidth(clip(s.name, 12)))) + 12)
  const cellW = (W - left - 8) / Math.max(1, n)
  const cellH = 32
  const labs = c.categories.map(s => clip(s, 8))
  const rotate = Math.max(0, ...labs.map(l => textWidth(l))) > cellW - 4
  const head = rotate ? Math.min(70, Math.max(...labs.map(l => textWidth(l))) * 0.62 + 12) : 24
  const H = head + c.series.length * cellH + 8
  const parts: string[] = ['<g class="rb-heat">']
  labs.forEach((l, i) => {
    const lx = left + cellW * (i + 0.5), ly = head - 8
    parts.push(`<text x="${r1(lx)}" y="${ly}" text-anchor="${rotate ? 'start' : 'middle'}"${rotate ? ` transform="rotate(-35 ${r1(lx)} ${ly})"` : ''} style="fill:var(--rb-ink2)">${escXml(l)}${l !== c.categories[i] ? `<title>${escXml(c.categories[i])}</title>` : ''}</text>`)
  })
  c.series.forEach((s, j) => {
    const cy = head + j * cellH
    parts.push(`<text x="${left - 8}" y="${cy + cellH / 2 + 4}" text-anchor="end" style="fill:var(--rb-ink2)">${escXml(clip(s.name, 12))}</text>`)
    s.values.forEach((v, i) => {
      const x = left + cellW * i
      if (v === null || !Number.isFinite(v)) { parts.push(`<rect class="rb-gap" x="${r1(x)}" y="${cy}" width="${r1(cellW)}" height="${cellH}" style="fill:var(--rb-page)"/>`); return }
      const t = hi === lo ? 0.5 : (v - lo) / (hi - lo)
      const pct = Math.round(8 + t * 62)
      parts.push(`<g class="rb-m"><rect class="rb-gap" x="${r1(x)}" y="${cy}" width="${r1(cellW)}" height="${cellH}" style="fill:color-mix(in srgb,var(--rb-s0) ${pct}%,var(--rb-page))"/>${cellW >= 30 ? `<text x="${r1(x + cellW / 2)}" y="${cy + cellH / 2 + 4}" text-anchor="middle" style="font-size:11px">${escXml(formatValue(v, f))}</text>` : ''}${tip(c.categories[i], s.name, v, f)}</g>`)
    })
  })
  parts.push('</g>')
  return wrap(c, W, H, parts.join(''))
}

// ───────────── 变量（网页导出自带；渲染端映射到设计 token） ─────────────
const SERIES_LIGHT = ['#5B57D1', '#4C9A74', '#3F86C9', '#B98733', '#A062B9', '#C87B4C', '#2C9AA0', '#C23F63']
const SERIES_DARK = ['#8F8CF0', '#6CC49C', '#6FB0E8', '#E0B060', '#C493E0', '#EAA079', '#52C4C8', '#F0809C']
export const chartVarsLight = (): string => `--rb-ink:#1C1B2E;--rb-ink2:#5E5D75;--rb-onbar:#FFFFFF;--rb-line:#E6E6EE;--rb-line-strong:#C9C9D6;--rb-page:#FFFFFF;${SERIES_LIGHT.map((c, i) => `--rb-s${i}:${c};`).join('')}`
export const chartVarsDark = (): string => `--rb-ink:#ECECF6;--rb-ink2:#A9A8C4;--rb-onbar:#14142A;--rb-line:#2E2E4A;--rb-line-strong:#44446A;--rb-page:#1D1D35;${SERIES_DARK.map((c, i) => `--rb-s${i}:${c};`).join('')}`
