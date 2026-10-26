#!/usr/bin/env node
// 打包入口：先构建（electron-vite build），再按平台调用 electron-builder。
//   node scripts/dist.cjs mac | win | all        （npm run dist:mac / dist:win / dist）
// 输出目录：默认 release/；如果项目所在的磁盘不适合打包（exFAT / FAT / 部分网络盘：不支持符号链接——Mac 的 .app 框架里全是符号链接；或会生成 ._ 文件），
// 自动改在 ~/.ewb-build 里打，最后把 dmg / exe 拷回 release/。也可以用环境变量 EWB_BUILD_DIR 指定。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const which = process.argv[2] || 'all'
if (!['mac', 'win', 'all'].includes(which)) { console.error('用法：node scripts/dist.cjs mac|win|all'); process.exit(2) }

const release = path.join(root, 'release')
function supportsSymlinks(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const a = path.join(dir, `.symtest-${process.pid}-a`), b = path.join(dir, `.symtest-${process.pid}-b`)
  try { fs.writeFileSync(a, 'x'); fs.symlinkSync(a, b); return fs.lstatSync(b).isSymbolicLink() } catch { return false } finally { for (const f of [a, b]) { try { fs.rmSync(f, { force: true }) } catch { /* 忽略 */ } } }
}
/** exFAT / FAT 在 macOS 上会给每个文件旁边生成 ._xxx（AppleDouble）：electron-builder 会把 ._app.asar 当成 asar 去读，直接崩 */
function producesAppleDouble(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `.adtest-${process.pid}`)
  try { fs.writeFileSync(f, 'x'); return fs.existsSync(path.join(dir, `._.adtest-${process.pid}`)) } catch { return false } finally { for (const x of [f, path.join(dir, `._.adtest-${process.pid}`)]) { try { fs.rmSync(x, { force: true }) } catch { /* 忽略 */ } } }
}
let outDir = process.env.EWB_BUILD_DIR ? path.resolve(process.env.EWB_BUILD_DIR) : release
// 只有在 macOS 上才有这个问题（Windows / Linux 主机直接在 release/ 里打）
if (!process.env.EWB_BUILD_DIR && process.platform === 'darwin' && (!supportsSymlinks(release) || producesAppleDouble(release))) {
  outDir = path.join(os.homedir(), '.ewb-build')
  console.log(`[dist] release/ 所在磁盘不适合打包（不支持符号链接，或会生成 ._ 文件，exFAT / FAT 常见），改在 ${outDir} 里打包，完成后把安装包拷回 release/`)
}
fs.mkdirSync(outDir, { recursive: true })

const run = (script, args, env = {}) => {
  console.log(`[dist] $ node ${path.relative(root, script)} ${args.join(' ')}`)
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) { console.error(`[dist] 失败（退出码 ${r.status}）`); process.exit(r.status || 1) }
}
/** 用 node 直接跑包里的 bin 脚本（不走 node_modules/.bin 的 shell 脚本：Windows 上那是 .cmd，spawn 不加 shell 跑不了） */
const nodeBin = (pkgName, binName = pkgName) => {
  const dir = path.join(root, 'node_modules', pkgName)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[binName]
  return path.join(dir, rel)
}

run(nodeBin('electron-vite'), ['build'])
const ebArgs = ['--config', 'electron-builder.config.cjs', '--publish', 'never']
if (which === 'mac' || which === 'all') run(nodeBin('electron-builder'), ['--mac', ...ebArgs], { EWB_BUILD_DIR: outDir, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
if (which === 'win' || which === 'all') run(nodeBin('electron-builder'), ['--win', ...ebArgs], { EWB_BUILD_DIR: outDir })

if (outDir !== release) {
  fs.mkdirSync(release, { recursive: true })
  for (const f of fs.readdirSync(outDir)) {
    if (/^EnglishExamWorkbench-.*\.(dmg|exe|zip|blockmap)$/.test(f) && !f.endsWith('.blockmap')) {
      fs.copyFileSync(path.join(outDir, f), path.join(release, f))
      console.log(`[dist] 已拷贝 ${f} → release/`)
    }
  }
}
// exFAT / FAT 上拷文件会生成 ._xxx（AppleDouble）：整个 release/ 传给别人时别带上这些小文件，顺手清掉
try { for (const f of fs.readdirSync(release)) if (f.startsWith('._')) fs.rmSync(path.join(release, f), { force: true }) } catch { /* 没有 release/ 就算了 */ }
console.log(`[dist] 完成。构建目录：${outDir}`)
