// 打包配置与源码的一致性（M5）：这些都是「改了一处忘了另一处，打出来的包就坏了」的类型，所以用静态检查守住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve('.')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const cfg = require(path.join(root, 'electron-builder.config.cjs'))

// ── 1. 基本信息 ──
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号是 x.y.z')
assert.equal(pkg.productName, '卷知')
assert.equal(cfg.productName, pkg.productName, '配置里的 productName 和 package.json 一致')
assert.match(cfg.appId, /^[a-z0-9.-]+$/i)
assert.equal(cfg.asar, true, 'asar 打包')
assert.equal(cfg.npmRebuild, false, '不重建原生模块（没有原生模块）')

// ── 2. 主进程在运行时 require / import 的包必须是 dependencies（打包只带 dependencies）──
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name.startsWith('._') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : [])
const bare = new Set()
for (const f of [...walk('src/main'), ...walk('src/preload'), ...walk('src/shared')]) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/(?:from\s+|import\(\s*|require\(\s*|require\.resolve\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
    const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0]
    if (name === 'electron' || name.startsWith('node:')) continue
    bare.add(name)
  }
}
assert.ok(bare.size >= 6, `扫到的主进程依赖数量异常：${[...bare]}`)
for (const name of bare) assert.ok(pkg.dependencies?.[name], `主进程用到了「${name}」，但它不在 dependencies 里（打包后会找不到）`)
// 反过来：只给渲染端用的大包（打进渲染端 bundle）不应该留在 dependencies 里，否则整套 antd 都会被塞进 app.asar
for (const name of ['antd', '@ant-design/icons', 'react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'dayjs']) {
  assert.ok(!pkg.dependencies?.[name] && pkg.devDependencies?.[name], `${name} 只给渲染端用，应在 devDependencies`)
}
// 主进程不能 import 渲染端才有的包
for (const name of ['antd', 'react', 'react-dom']) assert.ok(!bare.has(name), `主进程里不应 import ${name}`)

// ── 3. 运行时资源：OCR 组件在 asar 之外，路径与 src/main/pipeline/ocr.ts 一致 ──
const ocr = fs.readFileSync('src/main/pipeline/ocr.ts', 'utf8')
assert.match(ocr, /process\.resourcesPath!?,\s*'native'/, 'ocr.ts 在打包后从 resourcesPath/native 找组件')
const mac = cfg.mac.extraResources.find(r => r.to === 'native/macos/bin/ewb-ocr')
const win = cfg.win.extraResources.find(r => r.to === 'native/windows/ocr.ps1')
assert.ok(mac && fs.existsSync(mac.from), 'mac 的 extraResources 指向存在的 helper')
assert.ok(win && fs.existsSync(win.from), 'win 的 extraResources 指向存在的 ocr.ps1')
assert.match(ocr, /'macos',\s*'bin',\s*'ewb-ocr'/); assert.match(ocr, /'windows',\s*'ocr\.ps1'/)
assert.equal(fs.readFileSync(win.from).subarray(0, 3).toString('hex'), 'efbbbf', 'ocr.ps1 源文件带 BOM')
assert.ok(!(cfg.extraResources ?? []).length, 'OCR 组件只按平台放（不把 Windows 脚本放进 Mac 包，反之亦然）')
// pdf.js 资源：协议处理和渲染窗口都用 require.resolve('pdfjs-dist/package.json')，打包配置不能把用到的目录排除掉
const files = cfg.files.join('\n')
assert.ok(!/LICENSE/.test(files), '不排除许可证文件（随包分发要带许可证文本）')
const filesForPdfjsCheck = files.replace(/!node_modules\/pdfjs-dist\/legacy\/build\/\{pdf\.min,pdf\.worker\.min,pdf\.sandbox,pdf\.sandbox\.min\}\.mjs/, '')
for (const keep of ['legacy/build', 'cmaps', 'standard_fonts']) assert.ok(!new RegExp(`!node_modules/pdfjs-dist/[^\\n]*${keep}[^\\n]*`).test(filesForPdfjsCheck.replace(/!node_modules\/pdfjs-dist\/legacy\/\{web,image_decoders\}\/\*\*/, '')), `files 不能排除 pdfjs-dist 的 ${keep}`)
assert.match(files, /!\*\*\/\._\*/, '排除 ._ 文件（exFAT 上会满地都是）')
assert.match(files, /!node_modules\/@napi-rs\/\*\*/, '排除原生的 @napi-rs/canvas')
for (const f of ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs']) assert.ok(fs.existsSync(path.join('node_modules/pdfjs-dist', f)), f)
assert.ok(fs.existsSync('node_modules/pdfjs-dist/cmaps') && fs.existsSync('node_modules/pdfjs-dist/standard_fonts'))

// ── 3b. OCR helper 的执行位（M5 审核 P1-1）：入库模式、afterPack 无条件 chmod、运行时兜底 ──
{
  const { spawnSync } = await import('node:child_process')
  const ls = spawnSync('git', ['ls-files', '-s', 'native/macos/bin/ewb-ocr'], { cwd: root, encoding: 'utf8' })
  if (ls.status === 0 && ls.stdout.trim()) assert.match(ls.stdout, /^100755 /, 'ewb-ocr 在 git 里必须是 100755（exFAT 盘上看不出来：用 git update-index --chmod=+x）')
  else console.log('（不在 git 仓库里或没有跟踪该文件：跳过入库模式检查）')
  const ap = require(path.join(root, 'scripts/after-pack.cjs'))
  // 功能测试：造一个假的 .app，helper 是 644，afterPack 之后必须带执行位
  const os = await import('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-afterpack-'))
  try {
    const helper = path.join(tmp, 'X.app', ap.MAC_HELPER_REL)
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, 'x'); fs.chmodSync(helper, 0o644)
    const fake = { electronPlatformName: 'darwin', appOutDir: tmp, packager: { appInfo: { productFilename: 'X' } } }
    if (process.platform !== 'win32' && (fs.statSync(helper).mode & 0o111) === 0) {
      await ap.default(fake)
      assert.ok((fs.statSync(helper).mode & 0o111) === 0o111, 'afterPack 之后 helper 的 mode 含 0o111')
    } else await ap.default(fake)
    fs.rmSync(helper)
    await assert.rejects(() => ap.default(fake), /没有 OCR helper/, 'helper 不在包里就让打包失败（不静默放过）')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  const ocrSrc = fs.readFileSync(path.join(root, 'src/main/pipeline/ocr.ts'), 'utf8')
  assert.match(ocrSrc, /ensureExecutable\(getMacOcrBinary\(\)\)/, 'ocr.ts 运行时检查并尝试修复执行位')
  assert.match(ocrSrc, /const notExec = checkMacExecutable\(\)\n  if \(notExec\) return Promise\.reject\(notExec\)/, 'ocrImage：helper 不可执行 → 带中文原因 reject（走降级流程）')
  assert.match(ocrSrc, /notExec\) return Promise\.resolve\(\{ available: false/, '设置页的 OCR 状态也如实显示「不可用」和原因')
}

// ── 4. 产物命名、图标、卸载保留数据 ──
assert.equal(cfg.mac.identity, '-', 'Mac 用 ad-hoc 签名')
assert.equal(cfg.mac.notarize, false, '不公证')
assert.deepEqual(cfg.mac.target[0].arch.slice().sort(), ['arm64', 'x64'])
assert.ok(cfg.nsis.allowToChangeInstallationDirectory && cfg.nsis.createDesktopShortcut && cfg.nsis.oneClick === false, 'NSIS：可选目录、桌面快捷方式、非一键安装')
assert.equal(cfg.nsis.language, '2052', 'NSIS 中文界面')
assert.equal(cfg.nsis.deleteAppDataOnUninstall, false, '卸载不删老师的数据')
assert.equal(cfg.nsis.perMachine, false, '默认装给当前用户（不要求管理员权限）')
assert.deepEqual(cfg.win.target.map(t => t.target).sort(), ['nsis', 'portable'])
for (const f of ['build/icon.icns', 'build/icon.ico', 'build/icon.png']) assert.ok(fs.existsSync(f), f)
assert.equal(fs.readFileSync('build/icon.ico').readUInt16LE(2), 1, 'icon.ico 是 ICO')
assert.equal(fs.readFileSync('build/icon.icns').subarray(0, 4).toString('latin1'), 'icns')
assert.equal(fs.readFileSync('build/icon.png').subarray(1, 4).toString('latin1'), 'PNG')
assert.ok(fs.statSync('build/icon.png').size > 2000)
const names = {
  mac: cfg.mac.artifactName, setup: cfg.nsis.artifactName, portable: cfg.portable.artifactName
}
const fill = (t, extra = {}) => t.replace('${version}', pkg.version).replace('${ext}', extra.ext ?? '').replace('${arch}', extra.arch ?? '')
const expected = [fill(names.mac, { arch: 'arm64', ext: 'dmg' }), fill(names.mac, { arch: 'x64', ext: 'dmg' }), fill(names.setup, { ext: 'exe' }), fill(names.portable, { ext: 'exe' })]
assert.ok(expected.every(n => /^[\x20-\x7e]+$/.test(n)), '产物文件名全是 ASCII（下载和 CI 上传不会遇到中文名问题）：' + expected)
assert.deepEqual(expected, ['Juanzhi-' + pkg.version + '-mac-arm64.dmg', 'Juanzhi-' + pkg.version + '-mac-x64.dmg', 'Juanzhi-' + pkg.version + '-win-x64-setup.exe', 'Juanzhi-' + pkg.version + '-win-x64-portable.exe'], '安装包文件名')
// 开源许可：MIT，版权行写明
assert.equal(pkg.license, 'MIT')
assert.match(fs.readFileSync('LICENSE', 'utf8'), /^MIT License[\s\S]*Copyright \(c\) 2026 ooohhhooo/)
assert.equal(cfg.copyright, 'Copyright © 2026 ooohhhooo')
assert.ok(!/占位/.test(JSON.stringify(cfg)), 'electron-builder 配置里没有占位版权文字')
// 旧名「英语校考分析工作台」在界面、帮助、安装指南、配置里都换掉（docs 里的历史交付说明和审核记录不改）
{
  const w = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name.startsWith('._') ? [] : e.isDirectory() ? w(path.join(d, e.name)) : [path.join(d, e.name)])
  const files = [...w('src'), 'package.json', 'electron-builder.config.cjs', 'docs/安装指南.md', 'docs/验收清单.md', 'docs/Windows验收清单.md', 'scripts/verify-artifacts.cjs', 'tests/e2e/smoke-packaged.cjs']
  const left = files.filter(f => /\.(ts|tsx|html|json|cjs|md)$/.test(f) && fs.readFileSync(f, 'utf8').includes('英语校考分析工作台'))
  assert.deepEqual(left, [], '还留着旧名的文件')
}
// 安装指南里写的文件名必须和实际产物名一致
const guide = fs.readFileSync('docs/安装指南.md', 'utf8')
for (const n of expected) assert.ok(guide.includes(n), `安装指南里要写明文件名 ${n}`)
// 工作流用到的脚本都在
for (const s of ['dist:mac', 'dist:win', 'dist', 'test:unit']) assert.ok(pkg.scripts[s], `package.json 缺脚本 ${s}`)
const wf = fs.readFileSync('.github/workflows/build.yml', 'utf8')
for (const s of ['windows-latest', 'macos-latest', 'npm ci', 'npm run typecheck', 'npm run test:unit', 'smoke-packaged.cjs', 'upload-artifact']) assert.ok(wf.includes(s), `workflow 里缺 ${s}`)
assert.match(wf, /从来没有真正运行过/, 'workflow 注释里写明从未运行过')
// M7 命令行：workflow 里要有 Windows（PowerShell / cmd）和 Mac 的命令行检查，以及 OCR 诊断（区分脚本问题和环境问题）
for (const s of ['juanzhi.cmd', 'LASTEXITCODE', 'Start-Process', '--result-file', 'ocr-diagnose.ps1', 'shell: cmd']) assert.ok(wf.includes(s), `workflow 里缺命令行 / OCR 诊断检查：${s}`)
assert.ok(fs.existsSync('tests/e2e/cli-smoke.cjs') && fs.readFileSync('tests/e2e/smoke-packaged.cjs', 'utf8').includes('cli-smoke.cjs'), '打包版冒烟里要跑命令行检查')
const ocrDiag = fs.readFileSync('tests/e2e/ocr-diagnose.ps1')
assert.equal(ocrDiag.subarray(0, 3).toString('hex'), 'efbbbf', 'ocr-diagnose.ps1 带 BOM')
for (const verdict of ['ENV', 'SCRIPT', 'IMAGE', 'OK']) assert.ok(ocrDiag.includes(`'${verdict}'`), `OCR 诊断要能给出结论 ${verdict}`)
// release/ 不进仓库
assert.match(fs.readFileSync('.gitignore', 'utf8'), /^release\/$/m)

// ── Windows OCR 对「透明背景」PNG 读出 0 行（CI run 40478002979）的根因与修复 ──
{
  const zlib = await import('node:zlib')
  const png = fs.readFileSync('samples/g4-2025-page1.png')
  let o = 8, ct = -1; const idat = []
  while (o < png.length) { const len = png.readUInt32BE(o), type = png.subarray(o + 4, o + 8).toString('latin1'); if (type === 'IHDR') ct = png[o + 8 + 9]; if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  // 第一行第一个像素：任何滤波类型下它的原始字节就是像素值（左边和上边都是 0）
  assert.equal(ct, 6, '样张是 RGBA PNG'); assert.equal(raw[1 + 3], 0, '样张左上角像素的 alpha = 0：背景是透明的（字是黑的），不铺白底就是一片黑')
  const ps = fs.readFileSync('native/windows/ocr.ps1', 'utf8')
  for (const must of ['Convert-ToOpaquePng', 'BitmapAlphaMode]::Ignore', 'System.Drawing', 'Format24bppRgb', '[System.Drawing.Color]::White']) assert.ok(ps.includes(must), `ocr.ps1 要先把带透明通道的图铺白底：缺 ${must}`)
  assert.ok(ps.indexOf('Convert-ToOpaquePng $ImagePath') < ps.indexOf('GetSoftwareBitmapAsync('), '铺白底在识别之前')
}

// ── 5. userData 路径与 productName 无关（改 productName 不会让老师的数据「消失」）──
const idx = fs.readFileSync('src/main/index.ts', 'utf8')
assert.match(idx, /path\.join\(app\.getPath\('appData'\), 'english-exam-workbench'\)/, 'userData 固定为 <appData>/english-exam-workbench')
assert.match(idx, /app\.setName\('english-exam-workbench'\)/)
assert.equal(pkg.name, 'english-exam-workbench')
// ── 6. 老师看到的名字（M5 审核 P2-8）：app.name 是内部名，菜单 / 关于面板 / 窗口标题 / 任务栏标识不能依赖它 ──
{
  const { PRODUCT_NAME, APP_ID, WINDOW_TITLE } = await import(path.join(root, 'src/main/brand.ts'))
  const { buildMacMenuTemplate } = await import(path.join(root, 'src/main/menu-template.ts'))
  assert.equal(PRODUCT_NAME, pkg.productName, 'brand.PRODUCT_NAME = package.json productName')
  assert.equal(APP_ID, cfg.appId, 'brand.APP_ID = electron-builder appId（NSIS 快捷方式的任务栏标识）')
  for (const dev of [false, true]) {
    const t = buildMacMenuTemplate({ dev })
    const labels = JSON.stringify(t)
    assert.ok(!labels.includes('english-exam-workbench'), '菜单里不出现内部名')
    const app = t[0].submenu
    assert.equal(t[0].label, PRODUCT_NAME)
    assert.equal(app.find(i => i.role === 'about').label, `关于${PRODUCT_NAME}`)
    assert.equal(app.find(i => i.role === 'quit').label, `退出${PRODUCT_NAME}`)
    assert.equal(app.find(i => i.role === 'hide').label, `隐藏${PRODUCT_NAME}`)
    const edit = t.find(m => m.label === '编辑').submenu.map(i => i.role)
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) assert.ok(edit.includes(r), `编辑菜单要有 ${r}（macOS 上输入框的 Cmd+C/V 靠它）`)
    assert.equal(t.some(m => m.label === '视图'), dev, '开发者工具只在开发版里')
  }
  const idx2 = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  assert.match(idx2, /app\.setAppUserModelId\(APP_ID\)/); assert.match(idx2, /title: WINDOW_TITLE/); assert.match(idx2, /Menu\.setApplicationMenu/)
  assert.match(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'), new RegExp(`<title>${WINDOW_TITLE}</title>`), '页面标题 = 窗口标题「卷知 · 小学英语试卷分析」')
  assert.equal(WINDOW_TITLE, '卷知 · 小学英语试卷分析')
}
// ── 7. 用户看得到的文案里不能留开发里程碑的字样（M1–M5、「后续里程碑」、「占位」）──
{
  const offenders = []
  for (const f of [...walk('src/main'), ...walk('src/renderer'), ...walk('src/shared')]) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')   // 去掉行尾 // 注释和 /* */ 注释（粗略）
      if (/^\s*(\*|\/\*)/.test(line)) return
      for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
        if (/\bM[1-5]\b|里程碑|占位版|（M\d）/.test(m[2]) && !/^[A-Za-z0-9_.\-/@]+$/.test(m[2]) && !/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/.test(m[2])) offenders.push(`${path.relative(root, f)}:${i + 1}: ${m[2].slice(0, 60)}`)
      }
    })
  }
  assert.deepEqual(offenders, [], '用户可见文案里残留开发里程碑字样：\n' + offenders.join('\n'))
  // JSX 文本节点（> 文字 <）里同样不能有
  const jsx = []
  for (const f of walk('src/renderer')) fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/>[^<>{}]*(\bM[1-5]\b|里程碑)[^<>{}]*</.test(line) && !/^\s*(\/\/|\*)/.test(line)) jsx.push(`${path.relative(root, f)}:${i + 1}`) })
  assert.deepEqual(jsx, [], 'JSX 文字里残留里程碑字样：' + jsx.join(', '))
}
console.log('packaging-config.test ✓')
