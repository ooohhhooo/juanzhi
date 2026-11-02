// 核对打包输出里的更新清单（CI 和本机都能跑）：清单能被应用内更新的解析器读懂，里面列的每个文件都在目录里、sha512 和大小一致，
// 并且能按架构选出对应的包。用法：node --experimental-strip-types --no-warnings scripts/verify-update-manifests.mjs <目录> mac|win
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseManifest, pickMacZip, pickPortableExe, verifyFile } from '../src/main/update/core.ts'

const dir = path.resolve(process.argv[2] || 'release')
const which = process.argv[3] || (process.platform === 'darwin' ? 'mac' : 'win')
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const wanted = which === 'mac' ? ['latest-mac.yml'] : ['latest.yml', 'latest-portable.yml']
for (const name of wanted) {
  const file = path.join(dir, name)
  assert.ok(fs.existsSync(file), `缺少 ${name}`)
  const m = parseManifest(fs.readFileSync(file, 'utf8'))
  const expected = process.env.EWB_DIST_VERSION || version
  assert.equal(m.version, expected, `${name} 的版本应为 ${expected}`)
  for (const f of m.files) {
    const p = path.join(dir, f.url)
    assert.ok(fs.existsSync(p), `${name} 里列的 ${f.url} 不在目录里`)
    const r = await verifyFile(p, f)
    assert.ok(r.ok, `${f.url}：${r.reason}`)
  }
  if (name === 'latest-mac.yml') for (const arch of ['arm64', 'x64']) assert.ok(pickMacZip(m, arch), `${name} 里没有 ${arch} 的 zip`)
  if (name === 'latest-portable.yml') assert.ok(pickPortableExe(m), `${name} 里没有免安装版 exe`)
  if (name === 'latest.yml') assert.ok(m.files.some(f => /-setup\.exe$/.test(f.url)), 'latest.yml 里没有安装包')
  console.log(`✅ ${name}：版本 ${m.version}，${m.files.length} 个文件，sha512 与大小一致`)
}
