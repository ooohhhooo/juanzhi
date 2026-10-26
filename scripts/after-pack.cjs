// electron-builder afterPack：在「没有 Wine 的 Mac / Linux」上交叉打 Windows 包时，用纯 JS 的 resedit 给 exe 换图标、写版本信息。
// 在 Windows 上 electron-builder 自己用 rcedit 做（config 里 signAndEditExecutable = true），这里直接跳过。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** OCR helper 的路径（相对 .app）：不依赖它在 git / 磁盘上是什么权限，打包时一律加上执行位（M5 审核 P1-1：exFAT 上入库的是 644，干净 checkout 打出来的包里 helper 不可执行） */
const MAC_HELPER_REL = path.join('Contents', 'Resources', 'native', 'macos', 'bin', 'ewb-ocr')

function fixMacHelperMode(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const helper = path.join(app, MAC_HELPER_REL)
  if (!fs.existsSync(helper)) throw new Error(`afterPack: 包里没有 OCR helper：${helper}`)
  fs.chmodSync(helper, 0o755)
  if ((fs.statSync(helper).mode & 0o111) === 0 && process.platform !== 'win32') {
    // exFAT 等不保存权限位的磁盘上读回来总是 rwx；这里只在能保存权限的磁盘上才有意义的二次确认
    throw new Error(`afterPack: 无法给 ${helper} 加执行位`)
  }
  console.log('  • afterPack: OCR helper 已设置执行位 755')
}

exports.MAC_HELPER_REL = MAC_HELPER_REL

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') { fixMacHelperMode(context); return }
  if (context.electronPlatformName !== 'win32' || process.platform === 'win32') return
  const { packager, appOutDir } = context
  const info = packager.appInfo
  const exeName = `${packager.platformSpecificBuildOptions.executableName || info.productFilename}.exe`
  const exe = path.join(appOutDir, exeName)
  if (!fs.existsSync(exe)) throw new Error(`afterPack: 找不到 ${exe}`)
  const ResEdit = await import('resedit')
  const R = ResEdit.default ?? ResEdit
  const nt = R.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true })
  const res = R.NtExecutableResource.from(nt)
  // ① 图标：把 exe 里已有的每个图标组换成我们的 .ico（文件夹里看到的图标、任务栏图标、桌面快捷方式都取自这里）
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(packager.projectDir, 'build', 'icon.ico')))
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries)
  for (const g of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map(i => i.data))
  }
  // ② 版本信息（右键 → 属性 → 详细信息）
  const vis = R.Resource.VersionInfo.fromEntries(res.entries)
  const vi = vis[0] ?? R.Resource.VersionInfo.createEmpty()
  const ver = String(info.version).split('.').map(n => parseInt(n, 10) || 0)
  while (ver.length < 3) ver.push(0)
  vi.setFileVersion(ver[0], ver[1], ver[2], 0, 1033)
  vi.setProductVersion(ver[0], ver[1], ver[2], 0, 1033)
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: info.productName, ProductName: info.productName, CompanyName: info.companyName || info.productName,
    LegalCopyright: info.copyright || '', OriginalFilename: exeName, InternalName: exeName, FileVersion: info.version, ProductVersion: info.version
  })
  vi.outputToResourceEntries(res.entries)
  res.outputResource(nt)
  fs.writeFileSync(exe, Buffer.from(nt.generate()))
  console.log(`  • afterPack: 已用 resedit 更新 ${exeName} 的图标和版本信息（无 Wine 交叉打包）`)
}
