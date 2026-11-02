import React, { useState } from 'react'
import { Modal } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Btn, UsageNote } from '../design'
import { groupPages, rangeText } from '../../shared/recognizer-text'
import type { PageRec } from '../../shared/recognizer-text'

/** 「怎么安装中文识别」：三步说明 + 打开 Windows 语言设置 + 完整教程 + 重新检测（只在 Windows 上出现） */
export function InstallZhOcr({ label = '怎么安装中文识别', size }: { label?: string; size?: 'small' }) {
  const [open, setOpen] = useState(false)
  const [check, setCheck] = useState<string | null>(null)
  const recheck = async () => {
    const s = await window.api.ocr.status()
    setCheck(s.available && s.lang && /^zh/i.test(s.lang) ? `已检测到中文识别（${s.lang}）。重新导入或点「重新提取」后就会用上。` : `还没有检测到中文识别：${s.detail}。装好后需要重启本软件。`)
  }
  return (
    <>
      <Btn tone="secondary" size={size} data-testid="install-zh-ocr" onClick={() => { setOpen(true); setCheck(null) }}>{label}</Btn>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} title="给这台电脑装上中文识别" width={520} destroyOnHidden>
        <div data-testid="install-zh-ocr-dialog">
          <p>Windows 自带的文字识别需要“中文（简体）”的识别包，没装的话图片和扫描件里的中文会认不全。三步装好：</p>
          <ol style={{ paddingLeft: 20, lineHeight: 1.9 }}>
            <li>点下面的「打开 Windows 语言设置」，进入“语言和区域”。</li>
            <li>点“添加语言”，选“中文（简体，中国）”，安装时勾选“光学字符识别”，等它下载完。</li>
            <li>装好后重启本软件，再点“我装好了，重新检测”。</li>
          </ol>
          <p style={{ color: 'var(--ewb-ink-2)' }}>公司电脑被限制装语言包的话，也可以在「设置 → AI 服务」里选“图片和扫描件一律交给 AI 读图”。</p>
          {check && <UsageNote kind="tip" data-testid="install-zh-ocr-check">{check}</UsageNote>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Btn tone="primary" data-testid="open-language-settings" onClick={() => { window.api.os.openLanguageSettings() }}>打开 Windows 语言设置</Btn>
            <Btn tone="secondary" onClick={recheck}>我装好了，重新检测</Btn>
            <Btn tone="secondary" data-testid="open-ocr-tutorial" onClick={() => { window.api.os.openOcrTutorial() }}>查看完整教程</Btn>
          </div>
        </div>
      </Modal>
    </>
  )
}

/** 一份卷子每页的识别方式：「第 1–3 页：Windows 自带识别（English）　中文可能认不全　[怎么安装中文识别]」，每条后面一句为什么 */
export function RecognitionCard({ paperId }: { paperId: string }) {
  const { data: diag } = useQuery({ queryKey: ['diag', paperId], queryFn: () => window.api.papers.diag(paperId), staleTime: 5_000 })
  if (!diag || diag.pages.length === 0) return null
  const recs: PageRec[] = diag.pages.map(p => ({ idx: p.idx, recognizer: p.recognizer, ocrLang: p.ocrLang, reason: p.reason, low: p.low }))
  if (recs.every(r => !r.recognizer)) return null   // 旧数据还没有记录：不显示一张空卡
  const groups = groupPages(recs)
  const win = diag.platform === 'win32'
  return (
    <UsageNote kind={diag.incomplete ? 'caution' : 'tip'} label="识别方式" title={diag.incomplete ? '这份卷子的识别可能不完整' : '每一页是怎么识别的'} data-testid="recognition-card">
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {groups.map((g, i) => (
          <li key={i} data-testid="recognition-line" style={{ marginBottom: 6 }}>
            <b>{rangeText(g)}：</b>{g.title}
            {g.note && <span data-testid="recognition-note" style={{ marginInlineStart: 10 }}>{g.note}</span>}
            {g.needsZhPack && win && <span style={{ marginInlineStart: 10 }}><InstallZhOcr size="small" /></span>}
            {g.legacyWin && (
              <div data-testid="recognition-legacy" style={{ color: 'var(--ewb-ink-2)', fontSize: 'var(--ewb-fs-sm)' }}>
                这份卷子是旧版本导入的，没有记下识别用的语言。重新提取后，卷知才能检查中文识别够不够用。{' '}
                <Btn tone="secondary" size="small" onClick={() => { window.api.papers.reprocess(paperId) }}>重新提取</Btn>
              </div>
            )}
            {g.why && <div style={{ color: 'var(--ewb-ink-2)', fontSize: 'var(--ewb-fs-sm)' }}>{g.why}</div>}
          </li>
        ))}
      </ul>
    </UsageNote>
  )
}

/** 「N 道题没找到位置」：解析完成后提示，并一键跳去审核页框选第一道 */
export function MissingBoxNotice({ paperId, canGoReview = true }: { paperId: string; canGoReview?: boolean }) {
  const nav = useNavigate()
  const { data: diag } = useQuery({ queryKey: ['diag', paperId], queryFn: () => window.api.papers.diag(paperId), staleTime: 5_000 })
  if (!diag || diag.locate.total === 0) return null
  const n = diag.locate.missing.length
  if (n === 0) return null
  const first = diag.locate.missing[0]
  return (
    <UsageNote kind="caution" label="注意" title={`${n} 道题没找到位置`} data-testid="missing-box-notice"
      actions={canGoReview ? <Btn tone="primary" data-testid="goto-first-missing" onClick={() => nav(`/review/${paperId}?q=${first.id}`)}>去框一下</Btn> : undefined}>
      这些题还没在原卷上框出位置，“出自原卷”里就看不到它们的截图（共 {diag.locate.total} 道题，已找到 {diag.locate.located} 道）：第 {diag.locate.missing.slice(0, 12).map(m => m.no).join('、')} 题{n > 12 ? ' 等' : ''}。
      在审核页选中这道题、在页面图上拖一个框，截图马上就有了。
    </UsageNote>
  )
}
