/**
 * 助手把用户在对话里附上的试卷（截图、图片、PDF、Word）导入试卷库：和拖进试卷库一样登记、提取，提取完接着 AI 识别。
 * 截图怎么分成「几份卷子」由模型根据每张图识别出的文字判断（卷名、页码、题号是否接着），用 groups 传进来；
 * 每组图片按顺序合成一份 PDF（一张一页）。依赖 electron，在 all-tools.ts 里加进去。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { allowPath } from '../allowedPaths'
import { registerImports } from '../pipeline/queue'
import { imagesToPdf } from '../pipeline/images-to-pdf'
import { sessionAttachSources } from './attachments'
import type { AttachSource } from './attachments'
import type { AgentTool } from './tool-types'

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.bmp']
const PAPER_EXT = ['.pdf', '.docx', ...IMAGE_EXT]
const isImage = (p: string) => IMAGE_EXT.includes(path.extname(p).toLowerCase())

const Params = z.object({
  groups: z.array(z.object({
    files: z.array(z.string().max(160)).min(1).max(30).describe('这份卷子的附件文件名，按页码顺序'),
    title: z.string().max(60).optional().describe('卷名（识别出来的，可选）')
  })).min(1).max(20).optional().describe('怎么分成几份卷子：每组是一份卷子，组里的图片按顺序合成一份（PDF / Word 文件各自单独一份，不要和图片放一组）。不写 = 所有图片合成一份'),
})
type Args = z.infer<typeof Params>

const label = (g: { files: string[]; title?: string }) => `${g.title ? `《${g.title}》` : '一份卷子'}：${g.files.join('、')}`

export const paperImport: AgentTool<Args> = {
  name: 'paper_import',
  description: [
    '把用户在这次对话里附上的试卷（截图、图片、PDF、Word）导入试卷库，导入后自动开始 AI 识别（拆题、标知识点），和用户自己拖进试卷库一样。只有用户明确要导入时才用。',
    '多张截图时先判断是一份还是几份卷子：看每张图识别出的文字——卷名 / 学校 / 年级是否相同、有没有「第 x 页 共 y 页」、题号是接着上一张（一、二 → 三、四）还是重新从「一」开始。',
    '把同一份卷子的图片按页码顺序放进同一组（groups），不同卷子分开。判断不了、或只有一张图却明显缺页时，先用 ask_user 把你的分组说给用户确认（例如「截图1–3 是《四年级期末卷》，截图4–5 是另一份，对吗？」），确认后再导入。',
    '识别要几分钟，完成后老师要在「审核」页核对，审核通过的试卷才会计入统计和分析。'
  ].join(''),
  params: Params,
  level: 'write',
  preview: a => a.groups?.length ? `导入 ${a.groups.length} 份试卷并开始 AI 识别（会调用 AI）：\n${a.groups.map(label).join('\n')}` : '把这次对话里的图片合成一份试卷导入试卷库，并开始 AI 识别（会调用 AI）',
  async run(a, ctx) {
    const all = sessionAttachSources(ctx.sessionId).filter(x => PAPER_EXT.includes(path.extname(x.path).toLowerCase()) && fs.existsSync(x.path))
    if (!all.length) return { ok: false, message: '这次对话里没有能导入的试卷附件（支持图片、PDF、Word）。附件只在软件开着期间保留，重启过的话请重新拖入或粘贴。' }
    // 名字可能重复（用户贴了两次同名文件）：按出现顺序一个个用掉
    const left = [...all]
    const take = (name: string): AttachSource | undefined => { const i = left.findIndex(x => x.name === name); return i >= 0 ? left.splice(i, 1)[0] : undefined }
    const groups: Array<{ items: AttachSource[]; title?: string }> = []
    const missing: string[] = []
    if (a.groups?.length) {
      for (const g of a.groups) {
        const items: AttachSource[] = []
        for (const n of g.files) { const x = take(n); if (x) items.push(x); else missing.push(n) }
        // PDF / Word 不能和图片合并：各自单独一份
        for (const d of items.filter(x => !isImage(x.path))) groups.push({ items: [d] })
        const imgs = items.filter(x => isImage(x.path))
        if (imgs.length) groups.push({ items: imgs, title: g.title })
      }
    } else {
      for (const d of all.filter(x => !isImage(x.path))) groups.push({ items: [d] })
      const imgs = all.filter(x => isImage(x.path))
      if (imgs.length) groups.push({ items: imgs })
    }
    if (missing.length && !groups.length) return { ok: false, message: `找不到这些附件：${missing.join('、')}。附件名以用户消息下显示的为准。` }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-paper-'))
    const paths: string[] = []
    let merged = 0
    for (const [i, g] of groups.entries()) {
      const one = g.items[0]
      if (g.items.length === 1 && !isImage(one.path)) { paths.push(one.path); continue }
      if (g.items.length === 1 && ['.jpg', '.jpeg', '.png', '.heic'].includes(path.extname(one.path).toLowerCase()) && !g.title) { paths.push(one.path); continue }
      const safe = (g.title ?? '').replace(/[\\/:*?"<>|]/g, '').trim()
      const out = path.join(dir, `${safe || `对话里的试卷${groups.length > 1 ? i + 1 : ''}`}（${g.items.length} 页）.pdf`)
      await imagesToPdf(g.items.map(x => x.path), out)
      paths.push(out)
      if (g.items.length > 1) merged++
    }
    paths.forEach(allowPath)
    const res = await registerImports(paths, { parseAfter: true })
    const ok = res.filter(r => r.paperId)
    const dup = res.filter(r => r.code === 'duplicate')
    const bad = res.filter(r => r.error && r.code !== 'duplicate')
    const lines = [
      ok.length ? `已导入 ${ok.length} 份试卷${merged ? `（其中 ${merged} 份是多张截图合成的）` : ''}：${ok.map(r => `「${r.fileName}」`).join('、')}。正在提取和 AI 识别，几分钟后在「试卷库」能看到进度，识别完要在「审核」页核对。` : '没有导入新的试卷。',
      ...dup.map(r => `「${r.fileName}」和已有试卷内容相同，没有重复导入（${r.error}）。`),
      ...bad.map(r => `「${r.fileName}」没能导入：${r.error}`),
      ...(missing.length ? [`这些附件名没找到，跳过了：${missing.join('、')}`] : []),
      ...(left.length && a.groups?.length ? [`这些附件没有放进任何一组，没有导入：${left.map(x => x.name).join('、')}`] : [])
    ]
    return { ok: ok.length > 0 || dup.length > 0, message: lines.join('\n'), data: { paperIds: ok.map(r => r.paperId) } }
  }
}
