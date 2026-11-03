/**
 * 网页导出：单个 html，内联 CSS 和 SVG（图表用 chart-svg.ts 的同一套渲染），不引用任何外部资源。
 * 浅色 / 深色跟随系统（prefers-color-scheme）；表头点一下可排序（一小段内联脚本，无外部依赖）。
 */
import { markdownToHtml } from '../../../shared/mdhtml.ts'
import { CHART_CSS, chartVarsDark, chartVarsLight, escXml, renderChartSvg } from './chart-svg.ts'
import { formatCell, isHighlighted, type Block, type BoardSpec } from './spec.ts'

const e = escXml

const CSS = `
:root{${chartVarsLight()}--bg:#ECECF1;--canvas:#FFFFFF;--soft:#F6F6FB;--primary:#5B57D1;--primary-soft:#EEEDFB;--hi:#FFF4D6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{${chartVarsDark()}--bg:#14142A;--canvas:#1D1D35;--soft:#25253F;--primary:#8F8CF0;--primary-soft:#2B2A55;--hi:#4A3F1C;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--rb-ink);font:15px/1.7 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
.canvas{background:var(--canvas);border-radius:20px;padding:32px;margin-bottom:16px}
h1{font-size:28px;margin:0 0 4px;line-height:1.3}h2{font-size:21px;margin:0 0 8px}h3{font-size:16px;margin:0 0 8px}
.sub{color:var(--rb-ink2);margin:0}.note{color:var(--rb-ink2);font-size:13px}
.findings{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:20px}
.finding{background:var(--primary-soft);border-radius:14px;padding:14px 16px}.finding h3{color:var(--primary)}.finding p{margin:0}
.block{margin-top:20px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--soft);border-radius:14px;padding:12px 14px}.kpi b{display:block;font-size:24px;line-height:1.3}.kpi span{color:var(--rb-ink2);font-size:13px}
.good{color:#2E8B62}.bad{color:#C23F63}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--rb-line);text-align:left;white-space:nowrap}td.n,th.n{text-align:right}
th{background:var(--soft);cursor:pointer;user-select:none}th:hover{color:var(--primary)}tr.hi td{background:var(--hi)}
.src{display:inline-block;font-size:12px;color:var(--rb-ink2);border:1px solid var(--rb-line-strong);border-radius:999px;padding:0 8px;margin-left:8px}
ol.cal{padding-left:22px;margin:8px 0 0}ol.cal li{margin:4px 0}
.md p{margin:6px 0}.md ul,.md ol{margin:6px 0;padding-left:22px}
footer{color:var(--rb-ink2);font-size:12px;text-align:center}
@media print{body{background:#fff}.canvas{break-inside:avoid}}
${CHART_CSS}`

const SCRIPT = `document.querySelectorAll('table.sortable').forEach(function(t){t.querySelectorAll('th').forEach(function(th,i){th.addEventListener('click',function(){var b=t.tBodies[0],rows=[].slice.call(b.rows),d=th.dataset.d==='1'?-1:1;th.dataset.d=d===1?'1':'0';rows.sort(function(x,y){var a=x.cells[i],c=y.cells[i],av=a.dataset.v,cv=c.dataset.v;if(av!==undefined&&cv!==undefined&&av!==''&&cv!=='')return (parseFloat(av)-parseFloat(cv))*d;if(av===''||av===undefined)return 1;return a.textContent.localeCompare(c.textContent,'zh')*d});rows.forEach(function(r){b.appendChild(r)})})})});`

function sourceTag(b: Block): string {
  return 'source' in b && b.source ? `<span class="src" title="${e(b.source.queryId)}">出处 ${e(b.source.queryId)}</span>` : ''
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'chart':
      return `<div class="block"><h3>${e(b.chart.title)}${sourceTag(b)}</h3>${renderChartSvg(b.chart)}${b.chart.notes ? `<p class="note">${e(b.chart.notes)}</p>` : ''}</div>`
    case 'table': {
      const head = b.columns.map(c => `<th class="${c.format && c.format !== 'text' ? 'n' : ''}">${e(c.label)}</th>`).join('')
      const body = b.rows.map(r => `<tr${isHighlighted(r, b.columns, b.highlight) ? ' class="hi"' : ''}>${b.columns.map(c => {
        const v = r[c.key]
        const num = typeof v === 'number'
        return `<td class="${num ? 'n' : ''}" data-v="${num ? v : ''}">${e(formatCell(v, c.format))}</td>`
      }).join('')}</tr>`).join('')
      return `<div class="block">${b.title ? `<h3>${e(b.title)}${sourceTag(b)}</h3>` : sourceTag(b)}<div class="tw"><table class="sortable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`
    }
    case 'text':
      return `<div class="block md">${markdownToHtml(b.markdown)}</div>`
    case 'kpi':
      return `<div class="block"><div class="kpis">${b.items.map(k => {
        const cls = k.delta && k.deltaGood ? (/^[-−↓]/.test(k.delta) === (k.deltaGood === 'down') ? 'good' : 'bad') : ''
        return `<div class="kpi"><span>${e(k.label)}</span><b>${e(k.value)}</b>${k.delta ? `<span class="${cls}">${e(k.delta)}</span>` : ''}</div>`
      }).join('')}</div>${sourceTag(b)}</div>`
  }
}

export function buildBoardHtml(spec: BoardSpec): string {
  const head = `<section class="canvas"><h1>${e(spec.title)}</h1>${spec.subtitle ? `<p class="sub">${e(spec.subtitle)}</p>` : ''}${spec.dataNote ? `<p class="note">数据范围：${e(spec.dataNote)}</p>` : ''}` +
    (spec.findings.length ? `<h2 style="margin-top:20px">核心发现</h2><div class="findings">${spec.findings.map(f => `<div class="finding"><h3>${e(f.title)}</h3><p>${e(f.body)}</p></div>`).join('')}</div>` : '') + '</section>'
  const sections = spec.sections.map(s => `<section class="canvas" id="${e(s.id)}"><h2>${e(s.title)}</h2>${s.intro ? `<p>${e(s.intro)}</p>` : ''}${s.blocks.map(blockHtml).join('')}</section>`).join('')
  const caliber = spec.caliber.length ? `<section class="canvas"><h2>口径说明</h2><ol class="cal">${spec.caliber.map(c => `<li>${e(c)}</li>`).join('')}</ol></section>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(spec.title)}</title><style>${CSS}</style></head><body><div class="wrap">${head}${sections}${caliber}<footer>由卷知生成</footer></div><script>${SCRIPT}</script></body></html>`
}
