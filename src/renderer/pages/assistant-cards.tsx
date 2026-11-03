import React, { useEffect, useState } from 'react'
import { App, Modal } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eye } from 'lucide-react'
import { Btn } from '../design'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 一张模板的缩略图（实时渲染示例，主进程一次只渲染一张，所以按顺序慢慢出来） */
function Thumb({ t, picked, onPick, onZoom }: { t: CardTemplateInfo; picked: boolean; onPick: () => void; onZoom: () => void }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.cards.preview(t.id, true).then(u => { if (alive) setSrc(u) }).catch(() => undefined)
    return () => { alive = false }
  }, [t.id])
  return (
    <div data-testid={`card-tpl-${t.id}`} data-picked={picked ? '1' : undefined} style={{ width: 112, textAlign: 'center' }}>
      <button type="button" onClick={onPick} aria-pressed={picked} aria-label={`设为默认：${t.name}`} title={t.scene}
        style={{ display: 'block', width: 112, height: 150, padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: '#f3f3f6', border: picked ? `3px solid ${t.accent}` : '3px solid transparent', outline: picked ? '1px solid rgba(0,0,0,.15)' : '1px solid rgba(0,0,0,.08)', position: 'relative' }}>
        {src ? <img src={src} alt={t.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <span style={{ fontSize: 12, color: '#999', lineHeight: '144px' }}>生成中…</span>}
        {picked && <span style={{ position: 'absolute', right: 4, top: 4, background: t.accent, color: '#fff', borderRadius: 10, width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Check size={13} strokeWidth={3} /></span>}
      </button>
      <div style={{ fontSize: 12, marginTop: 4, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
        <span style={{ fontWeight: picked ? 700 : 400 }}>{t.name}</span>
        <button type="button" onClick={onZoom} aria-label={`预览大图：${t.name}`} data-testid={`card-zoom-${t.id}`} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, color: '#666' }}><Eye size={13} strokeWidth={1.9} /></button>
      </div>
    </div>
  )
}

/** 助手设置 → 分享卡片：给学生 / 给家长各选一套默认模板，设置孩子称呼 */
export function CardsPanel() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['cards', 'templates'], queryFn: () => window.api.cards.templates(), staleTime: 0 })
  const [zoom, setZoom] = useState<{ t: CardTemplateInfo; src: string | null } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['cards', 'templates'] })
  const setDefault = async (a: 'student' | 'parent', id: string) => { try { await window.api.cards.setDefault(a, id); await refresh() } catch (e) { message.error(clean(e)) } }
  const setName = async (m: 'first' | 'none') => { try { await window.api.cards.setChildName(m); await refresh() } catch (e) { message.error(clean(e)) } }
  const openZoom = (t: CardTemplateInfo) => { setZoom({ t, src: null }); void window.api.cards.preview(t.id, false).then(src => setZoom(z => (z && z.t.id === t.id ? { ...z, src } : z))).catch(e => message.error(clean(e))) }
  const group = (a: 'student' | 'parent', title: string, hint: string) => (
    <div>
      <b>{title}</b>
      <p className="ewb-lib-sub" style={{ margin: '2px 0 8px' }}>{hint}点一张设为默认，助手出卡片时就用它。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {(data?.[a] ?? []).map(t => <Thumb key={t.id} t={t} picked={data?.settings.defaults[a] === t.id} onPick={() => void setDefault(a, t.id)} onZoom={() => openZoom(t)} />)}
      </div>
    </div>
  )
  return (
    <div data-testid="assistant-cards" style={{ display: 'grid', gap: 18, maxHeight: '62vh', overflowY: 'auto', paddingRight: 4 }}>
      {group('student', '给学生的卡片', '动漫动画风，知识点 / 口诀 / 小练习。')}
      {group('parent', '给家长的卡片', '稍正式，本周学情 / 阶段进步 / 学习简报。')}
      <div>
        <b>孩子称呼</b>
        <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>给家长的卡片上怎么称呼孩子。</p>
        <div className="ewb-as-seg ewb-as-seg--small" role="group" aria-label="孩子称呼" style={{ display: 'inline-flex' }}>
          <button type="button" data-testid="card-name-first" aria-pressed={data?.settings.childName !== 'none'} onClick={() => void setName('first')}>只写名（不带姓）</button>
          <button type="button" data-testid="card-name-none" aria-pressed={data?.settings.childName === 'none'} onClick={() => void setName('none')}>不写名字</button>
        </div>
      </div>
      <Modal open={!!zoom} title={zoom ? `${zoom.t.name}（示例）` : ''} onCancel={() => setZoom(null)} footer={<Btn tone="secondary" onClick={() => setZoom(null)}>关闭</Btn>} width={460} zIndex={1100} destroyOnClose>
        {zoom?.src ? <img src={zoom.src} alt={zoom.t.name} data-testid="card-zoom-img" style={{ width: '100%', display: 'block', borderRadius: 8 }} /> : <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>生成中…</div>}
      </Modal>
    </div>
  )
}
