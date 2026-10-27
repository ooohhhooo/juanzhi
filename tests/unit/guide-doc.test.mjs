// 安装指南（docs/安装指南.md，也是应用里 /guide 页面的正文）：能被应用内的 Markdown 渲染器完整解析，并且覆盖任务要求的每个主题。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseBlocks } from '../../src/shared/markdown.ts'

const md = fs.readFileSync('docs/安装指南.md', 'utf8')
const body = md.replace(/^﻿?# [^\n]*\n/, '')   // 应用里去掉文件开头的一级标题（页面自己有标题）
const blocks = parseBlocks(body)
const flat = b => b.type === 'heading' ? [b.text] : b.type === 'p' ? [b.inline] : b.type === 'ul' || b.type === 'ol' ? b.items : b.type === 'quote' ? b.lines : b.type === 'table' ? [b.header, ...b.rows.flat()] : []
const textOf = inl => (Array.isArray(inl) ? inl : [inl]).flat().map(i => typeof i === 'string' ? i : i.type === 'cite' ? i.token : i.text ?? textOf(i)).join('')
const allText = blocks.flatMap(b => b.type === 'code' ? [b.text] : flat(b).map(textOf)).join('\n')

// 渲染器不认的写法不能出现（否则老师会看到字面的 ** 或 反引号）
assert.ok(!/\*\*/.test(allText), '粗体标记全部被渲染器解析掉了，没有残留的 **')
assert.ok(!/`/.test(allText.replace(/```/g, '')), '没有行内反引号（渲染器不支持行内代码）')
assert.ok(!/^\s*[-*] /m.test(allText) && !/^#{1,6} /m.test(allText), '没有没被识别成列表 / 标题的残留')
assert.ok(!/\]\(http/.test(allText), '没有 [文字](链接) 写法（渲染器不支持链接）')
assert.ok(!blocks.some(b => b.type === 'p' && textOf(b.inline).includes('|') && /---/.test(textOf(b.inline))), '表格都被解析成了表格')
assert.ok(!blocks.some(b => b.type === 'quote' && b.lines.some(l => /\[[^\]]* · [^\]]*\]/.test(textOf(l)))), '没有会被误当成「试卷 · 题号」引用的方括号写法')
assert.ok(!/\[[^\]\n]+ · [^\]\n]+\]/.test(allText), '正文里没有 [x · y] 形式（会被当成引用卡片）')

// 主题覆盖（任务清单里要求的每一项）
const heads = blocks.filter(b => b.type === 'heading' && b.level === 2).map(b => b.text)
assert.ok(heads.length >= 9, `二级标题至少 9 个：${heads}`)
const must = [
  ['下载哪个文件', /Apple 芯片/, /Intel/, /关于本机/],
  ['Mac 首次打开', /右键|按住 Control/, /系统设置/, /隐私与安全性/, /仍要打开/, /macOS 15/],
  ['Windows SmartScreen', /更多信息/, /仍要运行/],
  ['Windows OCR 中文语言包', /时间和语言/, /添加语言/, /中文（简体/, /光学字符识别/, /基本键入/, /视觉模型/],
  ['配置 DeepSeek', /DeepSeek/, /API Key/, /测试连接/],
  ['换电脑迁移', /导出数据包/, /导入数据包/, /没有 API 密钥/],
  ['数据存在哪', /workbench-data/, /APPDATA|AppData/, /Application Support/],
  ['卸载与保留数据', /卸载/, /不会删除/, /english-exam-workbench/],
  ['常见问题', /常见问题/]
]
for (const [topic, ...res] of must) for (const re of res) assert.match(allText, re, `安装指南缺少「${topic}」：${re}`)
// 命令块里的 xattr 路径和产品名一致
assert.match(allText, /xattr -cr \/Applications\/英语校考分析工作台\.app/)
// ── M5 审核 P2-4/P2-5/P2-2：文档里的界面文字必须和应用里的一致；隐私、安装向导的描述要如实 ──
{
  const path = await import('node:path')
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name.startsWith('._') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|html)$/.test(e.name) ? [path.join(d, e.name)] : [])
  const ui = [...walk('src/renderer'), ...walk('src/main')].map(f => fs.readFileSync(f, 'utf8')).join('\n')
  const checklist = fs.readFileSync('docs/Windows验收清单.md', 'utf8')
  // 文档里点名的界面文字：每个都必须能在应用源码里找到原文（改了应用文案而忘了改文档会失败）
  const labels = ['数据包（换电脑 / 备份）', '示例数据', '数据存储', '文字识别（OCR）', 'AI 服务', '导出数据包…', '导入数据包…', '更改数据目录…', '加载示例数据', '清除示例数据', '恢复默认位置', '重试',
    '测试连接', '开始导入', '立即重启', '复制数据并切换', '开始使用：三步就能出第一份分析', '当前看的是示例数据', '内置的合成演示卷，不是任何真实考情', '这一页的 OCR 没有成功', '待 OCR（当前平台不支持）', 'OCR 失败',
    '生成报告', '导出 PDF', '导出 Markdown', '查看安装指南', '这是一个空文件夹', 'OCR 使用 ']
  for (const l of labels) assert.ok(ui.includes(l), `文档里用到的界面文字「${l}」在应用源码里找不到（文案改了？）`)
  const usedIn = (doc, l) => doc.includes(l)
  for (const l of ['数据包（换电脑 / 备份）', '示例数据', '数据存储', '文字识别（OCR）', '导出数据包…', '更改数据目录…', '加载示例数据']) assert.ok(usedIn(md, l) || usedIn(checklist, l), `文档里应使用界面原文「${l}」`)
  // 已知的错误写法不能再出现
  for (const [bad, why] of [['需要识别', '应用里没有这个标签'], ['首次使用', '卡片标题是「开始使用：…」'], ['示例数据：不是任何真实考情', '横幅原文不是这句'], ['设置 → 数据」', '设置里没有叫「数据」的卡片'], ['设置 → 查看安装指南', '入口在「设置 → 关于」里'],
    ['不收费、不联网', '公证与是否联网无关'], ['下错了也不会损坏电脑，只是打不开', 'Intel 包在 Apple 芯片上能靠 Rosetta 打开'], ['勾选「创建桌面快捷方式」', '安装向导里没有这个勾选项'], ['选择是否建桌面快捷方式', '安装向导里没有这个选项']]) {
    assert.ok(!md.includes(bad) && !checklist.includes(bad), `文档里不应再有「${bad}」（${why}）`)
  }
  // 隐私：必须如实说配视觉模型时会把页面图片发给 AI 服务商
  assert.match(md, /页面图片[^。]*发给你选择的 AI 服务商|页面图片会发送给你选择的 AI 服务商/, '指南要写明配视觉模型时页面图片会发给 AI 服务商')
  // 安装向导：「为谁安装」一页、默认目录是 ASCII 的 EnglishExamWorkbench、桌面快捷方式自动创建
  assert.match(md, /为谁安装/); assert.match(md, /仅为我/); assert.match(md, /Programs\\EnglishExamWorkbench/); assert.match(md, /自动/)
  assert.match(checklist, /为谁安装/); assert.match(checklist, /Programs\\EnglishExamWorkbench/); assert.match(checklist, /任务栏标识/); assert.match(checklist, /samples/)
  // 配置里确实是这样（文档与实际一致）
  const { createRequire } = await import('node:module')
  const cfg = createRequire(import.meta.url)(path.resolve('electron-builder.config.cjs'))
  assert.equal(cfg.nsis.createDesktopShortcut, true); assert.equal(cfg.nsis.oneClick, false); assert.equal(cfg.nsis.perMachine, false); assert.equal(cfg.win.executableName, 'EnglishExamWorkbench', '默认安装目录名取自 ASCII 的 executableName')
}
console.log('guide-doc.test ✓ 二级标题 ' + heads.length + ' 个：' + heads.join(' / '))
