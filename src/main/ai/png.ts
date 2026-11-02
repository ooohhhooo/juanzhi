import zlib from 'node:zlib'

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** 生成 w×h 的纯色 PNG（RGB）。视觉模型连通性测试用：有的服务商拒收边长过小（如 1×1）的图片 */
export function makeSolidPng(w: number, h: number, rgb: [number, number, number] = [200, 60, 60]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // 位深
  ihdr[9] = 2   // 颜色类型：RGB
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2] }
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}

/** 5×7 点阵字形：视觉测试图用（只画测试要用到的字符） */
const GLYPHS: Record<string, string[]> = {
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001']
}

/**
 * 白底黑字的点阵文字图（size×size，文字居中、每个点放大 scale 倍）。
 * 视觉模型测试用：让模型读出图上的字，读对 = 真的会看图（纯色图只能证明请求没被拒）。图由代码生成，不带任何外部素材。
 */
export function makeTextPng(text: string, size = 64, scale = 5): Buffer {
  const chars = Array.from(text).filter(c => GLYPHS[c])
  const gap = scale
  const textW = chars.length * 5 * scale + Math.max(0, chars.length - 1) * gap
  const x0 = Math.max(0, Math.floor((size - textW) / 2))
  const y0 = Math.max(0, Math.floor((size - 7 * scale) / 2))
  const px = new Uint8Array(size * size).fill(255)
  chars.forEach((c, ci) => {
    const gx = x0 + ci * (5 * scale + gap)
    GLYPHS[c].forEach((line, gy) => {
      for (let dx = 0; dx < 5; dx++) {
        if (line[dx] !== '1') continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const x = gx + dx * scale + sx, y = y0 + gy * scale + sy
          if (x < size && y < size) px[y * size + x] = 0
        }
      }
    })
  })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 0   // 灰度
  const raw = Buffer.alloc((1 + size) * size)
  for (let y = 0; y < size; y++) { raw[y * (1 + size)] = 0; Buffer.from(px.buffer, y * size, size).copy(raw, y * (1 + size) + 1) }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}
