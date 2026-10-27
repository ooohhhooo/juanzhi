// 单测用：最小的 PNG 解码（8 位、非隔行的 RGB / RGBA / 灰度）→ 灰度像素。页面图片都是应用自己渲染的这类 PNG。
import zlib from 'node:zlib'

export function decodeGray(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; if (data[12] !== 0) throw new Error('不支持隔行 PNG') }
    else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (depth !== 8) throw new Error('只支持 8 位')
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : ctype === 4 ? 2 : 0
  if (!bpp) throw new Error('不支持的颜色类型 ' + ctype)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let r
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1)
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
      out[y * stride + x] = r & 255
    }
  }
  const data = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp
    data[i] = bpp >= 3 ? (out[o] * 77 + out[o + 1] * 150 + out[o + 2] * 29) >> 8 : out[o]
    if (bpp === 4 && out[o + 3] < 255) data[i] = (data[i] * out[o + 3] + 255 * (255 - out[o + 3])) / 255
  }
  return { w, h, data }
}
