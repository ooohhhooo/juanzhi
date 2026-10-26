#!/usr/bin/env node
// 生成占位应用图标（纯 JS 光栅化，不依赖任何图形库）：build/icon.png（1024）、build/icon.ico（Windows）、build/icon.icns（macOS，需要 iconutil）。
// 这是「占位图标，可由设计替换」：替换 build/icon.png 之后重新运行本脚本（或直接替换 icns / ico）即可。
// 图案：蓝紫渐变圆角底 + 白色试卷 + 三根递增的柱状图（最高的一根用橙色强调）+ 两行示意文字。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')

const OUT = path.join(__dirname, '..', 'build')

// ── 极小的 SDF 光栅器 ──
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const mix = (a, b, t) => a + (b - a) * t
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
/** 圆角矩形的有符号距离（单位：像素；负数在里面） */
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function render(size) {
  const S = size
  const buf = Buffer.alloc(S * S * 4)
  const bgA = hex('#5C7CFA'), bgB = hex('#2B3F9E')
  const bars = [
    { x: 0.41, h: 0.11, c: hex('#91A7FF') },
    { x: 0.50, h: 0.185, c: hex('#5C7CFA') },
    { x: 0.59, h: 0.27, c: hex('#FF922B') }
  ]
  const base = 0.68, barW = 0.062
  const SS = size <= 64 ? 3 : 2   // 小尺寸多取几个子采样，边缘更顺
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / S, v = (y + (sy + 0.5) / SS) / S
      const px = u * S, py = v * S
      let col = [0, 0, 0], al = 0
      const over = (c, alpha) => { col = [mix(col[0], c[0], alpha), mix(col[1], c[1], alpha), mix(col[2], c[2], alpha)]; al = al + alpha * (1 - al) }
      // 底板
      const dBg = sdRoundRect(px, py, S / 2, S / 2, S * 0.43, S * 0.43, S * 0.19)
      if (dBg < 0.5) over([mix(bgA[0], bgB[0], v), mix(bgA[1], bgB[1], v), mix(bgA[2], bgB[2], v)], clamp(0.5 - dBg))
      // 试卷
      const dP = sdRoundRect(px, py, S * 0.5, S * 0.5, S * 0.235, S * 0.29, S * 0.035)
      if (dP < 0.5) over(hex('#FFFFFF'), clamp(0.5 - dP))
      // 示意文字两行
      for (const [x0, x1, yy] of [[0.30, 0.70, 0.31], [0.30, 0.56, 0.375]]) {
        const d = sdRoundRect(px, py, S * (x0 + x1) / 2, S * yy, S * (x1 - x0) / 2, S * 0.0105, S * 0.0105)
        if (d < 0.5) over(hex('#C5CEEA'), clamp(0.5 - d))
      }
      // 柱状图
      for (const br of bars) {
        const d = sdRoundRect(px, py, S * br.x, S * (base - br.h / 2), S * barW / 2, S * br.h / 2, S * 0.012)
        if (d < 0.5) over(br.c, clamp(0.5 - d))
      }
      // 基线
      const dl = sdRoundRect(px, py, S * 0.5, S * (base + 0.012), S * 0.14, S * 0.005, S * 0.005)
      if (dl < 0.5) over(hex('#C5CEEA'), clamp(0.5 - dl))
      r += col[0] * al; g += col[1] * al; b += col[2] * al; a += al
    }
    const n = SS * SS, o = (y * S + x) * 4
    const aa = a / n
    buf[o] = aa > 0 ? Math.round(r / n / aa) : 0
    buf[o + 1] = aa > 0 ? Math.round(g / n / aa) : 0
    buf[o + 2] = aa > 0 ? Math.round(b / n / aa) : 0
    buf[o + 3] = Math.round(aa * 255)
  }
  return buf
}

// ── PNG 编码 ──
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(rgba, S) {
  const raw = Buffer.alloc((S * 4 + 1) * S)
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
const pngOf = size => encodePng(render(size), size)

// ── ICO（PNG 内嵌，Vista 以上都支持）──
function encodeIco(sizes) {
  const pngs = sizes.map(pngOf)
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
  const dir = Buffer.alloc(16 * sizes.length)
  let off = 6 + dir.length
  sizes.forEach((s, i) => {
    const o = i * 16
    dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s; dir[o + 2] = 0; dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(off, o + 12)
    off += pngs[i].length
  })
  return Buffer.concat([head, dir, ...pngs])
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'icon.png'), pngOf(1024))
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256]))
console.log('build/icon.png, build/icon.ico 已生成')

// ── ICNS：用 macOS 自带的 iconutil（其它系统跳过，仓库里已有生成好的 build/icon.icns）──
if (process.platform === 'darwin') {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ewb-iconset-'))
  const set = path.join(tmp, 'icon.iconset')
  fs.mkdirSync(set)
  for (const [name, px] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
    fs.writeFileSync(path.join(set, `${name}.png`), pngOf(px))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')])
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('build/icon.icns 已生成')
} else console.log('非 macOS：跳过 icon.icns')
