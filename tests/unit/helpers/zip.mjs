// 单测用：手写的最小 ZIP 构造器，可以造出 yazl 不允许的「恶意」条目——路径穿越、绝对路径、反斜杠、符号链接、加密位、
// 头部声明的大小和实际不符、非常规压缩方式。条目：{ name, data, method?: 0|8|9, flags?, mode?（Unix 文件模式，带上就写 Unix 主机标记）, declaredSize?, declaredCompressed? }
import zlib from 'node:zlib'

export function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
    const method = e.method ?? 0
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw
    const crc = zlib.crc32(raw) >>> 0
    const flags = (e.flags ?? 0) | 0x800
    const usize = e.declaredSize ?? raw.length
    const csize = e.declaredCompressed ?? body.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22)
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, name, body)
    const ch = Buffer.alloc(46)
    const unix = e.mode !== undefined
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(unix ? (3 << 8) | 20 : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(unix ? (e.mode << 16) >>> 0 : 0, 38); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += lh.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, end])
}
