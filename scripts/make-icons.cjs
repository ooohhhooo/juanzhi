#!/usr/bin/env node
// 生成应用图标：build/icon.png（1024）、build/icon.ico（Windows，16/24/32/48/64/128/256）、build/icon.icns（macOS，需要 sips + iconutil）。
//
// 用法：
//   node scripts/make-icons.cjs                  有 build/icon-source.png（1024×1024 的源图）就用它生成全套图标；没有就画占位图标（后备）
//   node scripts/make-icons.cjs --src 路径.png   指定源图（必须是 1024×1024 的 PNG）
//   node scripts/make-icons.cjs --out 目录       输出到别的目录（默认 build/；试跑时用，不会动 build/ 里的图标）
// 源图的小尺寸（16/32……）按 Lanczos3 缩小（半透明边缘用预乘 alpha，不会出黑边）；macOS 上 icns 里的各尺寸用 sips 缩放，ico 里的用本脚本的纯 JS 缩放。
// 占位图案（没有源图时）：蓝紫渐变圆角底 + 白色试卷 + 三根递增的柱状图（最高的一根用橙色强调）+ 两行示意文字。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const OUT = path.resolve(arg('--out') || path.join(__dirname, '..', 'build'))
const SRC = path.resolve(arg('--src') || process.env.EWB_ICON_SOURCE || path.join(__dirname, '..', 'build', 'icon-source.png'))

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

// ── PNG 解码（源图用）：8/16 位的灰度、灰度+透明、RGB、RGBA、调色板；不支持隔行扫描 ──
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') throw new Error('不是 PNG 文件')
  let o = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  const idat = [], plte = [], trns = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.subarray(o + 4, o + 8).toString('latin1'), data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12] }
    else if (type === 'PLTE') plte.push(data)
    else if (type === 'tRNS') trns.push(data)
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + len
  }
  if (interlace) throw new Error('不支持隔行扫描（Adam7）的 PNG，请重新导出成普通 PNG')
  if (![8, 16].includes(depth) && ctype !== 3) throw new Error(`不支持 ${depth} 位的 PNG，请导出成 8 位`)
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]
  if (!ch) throw new Error(`不支持的 PNG 颜色类型 ${ctype}`)
  const bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y > 0 ? px[dst - stride + x] : 0, c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0
      let v = raw[src + x]
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      px[dst + x] = v & 255
    }
  }
  const pal = plte.length ? plte[0] : null, tr = trns.length ? trns[0] : null
  const out = Buffer.alloc(w * h * 4)
  const sample = (y, i) => (depth === 16 ? px[y * stride + i * 2] : px[y * stride + i])   // 16 位取高字节
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = (y * w + x) * 4
    let r, g, b, a = 255
    if (ctype === 6) { r = sample(y, x * 4); g = sample(y, x * 4 + 1); b = sample(y, x * 4 + 2); a = sample(y, x * 4 + 3) }
    else if (ctype === 2) { r = sample(y, x * 3); g = sample(y, x * 3 + 1); b = sample(y, x * 3 + 2) }
    else if (ctype === 0) { r = g = b = sample(y, x) }
    else if (ctype === 4) { r = g = b = sample(y, x * 2); a = sample(y, x * 2 + 1) }
    else {
      let idx
      if (depth === 8) idx = px[y * stride + x]
      else { const bit = x * depth, byte = px[y * stride + (bit >> 3)]; idx = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1) }
      if (!pal) throw new Error('调色板 PNG 缺少 PLTE')
      r = pal[idx * 3]; g = pal[idx * 3 + 1]; b = pal[idx * 3 + 2]; a = tr && idx < tr.length ? tr[idx] : 255
    }
    out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a
  }
  return { w, h, rgba: out }
}

// ── Lanczos3 缩放（预乘 alpha，两趟：先横后竖）──
const lanczos = x => { x = Math.abs(x); if (x < 1e-8) return 1; if (x >= 3) return 0; const p = Math.PI * x; return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p) }
function resizeAxis(src, sw, sh, dstLen, horizontal) {
  const srcLen = horizontal ? sw : sh, scale = srcLen / dstLen, support = Math.max(1, scale) * 3, fs_ = Math.max(1, scale)
  const outW = horizontal ? dstLen : sw, outH = horizontal ? sh : dstLen
  const out = new Float32Array(outW * outH * 4)
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * scale
    const lo = Math.max(0, Math.floor(center - support)), hi = Math.min(srcLen - 1, Math.ceil(center + support))
    const wts = []; let sum = 0
    for (let i = lo; i <= hi; i++) { const wv = lanczos((i + 0.5 - center) / fs_); wts.push(wv); sum += wv }
    const lines = horizontal ? sh : sw
    for (let l = 0; l < lines; l++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let i = lo; i <= hi; i++) {
        const wv = wts[i - lo] / sum
        const si = horizontal ? (l * sw + i) * 4 : (i * sw + l) * 4
        r += src[si] * wv; g += src[si + 1] * wv; b += src[si + 2] * wv; a += src[si + 3] * wv
      }
      const di = horizontal ? (l * outW + d) * 4 : (d * outW + l) * 4
      out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a
    }
  }
  return out
}
function resize(img, size) {
  if (img.w === size && img.h === size) return img.rgba
  const pre = new Float32Array(img.w * img.h * 4)
  for (let i = 0; i < img.w * img.h; i++) { const a = img.rgba[i * 4 + 3] / 255; pre[i * 4] = img.rgba[i * 4] * a; pre[i * 4 + 1] = img.rgba[i * 4 + 1] * a; pre[i * 4 + 2] = img.rgba[i * 4 + 2] * a; pre[i * 4 + 3] = img.rgba[i * 4 + 3] }
  const h1 = resizeAxis(pre, img.w, img.h, size, true)
  const v1 = resizeAxis(h1, size, img.h, size, false)
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(255, Math.max(0, v1[i * 4 + 3])), k = a > 0 ? 255 / a : 0
    out[i * 4] = Math.min(255, Math.max(0, Math.round(v1[i * 4] * k))); out[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(v1[i * 4 + 1] * k))); out[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(v1[i * 4 + 2] * k))); out[i * 4 + 3] = Math.round(a)
  }
  return out
}

// ── 选择图标来源：有源图用源图，没有就画占位 ──
let source = null, sourceBytes = null
if (fs.existsSync(SRC)) {
  sourceBytes = fs.readFileSync(SRC)
  source = decodePng(sourceBytes)
  if (source.w !== 1024 || source.h !== 1024) { console.error(`源图必须是 1024×1024 的 PNG，现在是 ${source.w}×${source.h}：${SRC}`); process.exit(1) }
  console.log(`使用源图 ${SRC}`)
} else console.log(`没有源图（${SRC}），画占位图标`)
const pngOf = size => (source ? encodePng(resize(source, size), size) : encodePng(render(size), size))

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
// icon.png：有源图就原样用源图（不重新编码，保持原样）
fs.writeFileSync(path.join(OUT, 'icon.png'), sourceBytes ?? pngOf(1024))
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256]))
console.log('icon.png, icon.ico 已生成：' + OUT)

// ── ICNS：用 macOS 自带的 sips（缩放）+ iconutil（打包）；其它系统跳过，仓库里已有生成好的 build/icon.icns ──
if (process.platform === 'darwin') {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ewb-iconset-'))
  const set = path.join(tmp, 'icon.iconset')
  fs.mkdirSync(set)
  const srcFile = path.join(tmp, 'source-1024.png')
  fs.writeFileSync(srcFile, sourceBytes ?? pngOf(1024))
  for (const [name, px] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
    const dst = path.join(set, `${name}.png`)
    if (source) {
      try { execFileSync('sips', ['-z', String(px), String(px), srcFile, '--out', dst], { stdio: 'ignore' }) } catch { fs.writeFileSync(dst, pngOf(px)) }   // sips 不可用时退回 JS 缩放
    } else fs.writeFileSync(dst, pngOf(px))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')])
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('icon.icns 已生成：' + OUT)
} else console.log('非 macOS：跳过 icon.icns')
