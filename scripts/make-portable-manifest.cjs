#!/usr/bin/env node
// 给 Windows 免安装版生成更新清单 latest-portable.yml（electron-builder 只给 NSIS 安装包生成 latest.yml）。
//   node scripts/make-portable-manifest.cjs <打包输出目录>
// 格式和 electron-builder 的 latest.yml 相同（version / files[url, sha512 base64, size] / releaseDate），应用内更新（src/main/update）用同一个解析器读。
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const dir = path.resolve(process.argv[2] || 'release')
const exes = fs.readdirSync(dir).filter(f => /^Juanzhi-.*-win-x64-portable\.exe$/.test(f))
if (exes.length !== 1) { console.error(`[portable-manifest] 在 ${dir} 里应该有且只有一个免安装版 exe，实际 ${exes.length} 个`); process.exit(1) }
const file = path.join(dir, exes[0])
const version = /^Juanzhi-(.+)-win-x64-portable\.exe$/.exec(exes[0])[1]
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
const size = fs.statSync(file).size
const yml = `version: ${version}\nfiles:\n  - url: ${exes[0]}\n    sha512: ${sha512}\n    size: ${size}\npath: ${exes[0]}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`
fs.writeFileSync(path.join(dir, 'latest-portable.yml'), yml)
console.log(`[portable-manifest] 已生成 latest-portable.yml（${exes[0]}，${size} 字节）`)
