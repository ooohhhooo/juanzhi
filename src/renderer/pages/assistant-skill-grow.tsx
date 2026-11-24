import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, Checkbox, Input, Modal, Spin, Tag } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ThumbsUp, Sparkles, X } from 'lucide-react'
import { Btn } from '../design'
import { composeBody, lineDiff } from '../../main/agent/skills/compose'
import type { SkillDraft, DraftStep } from '../../main/agent/skills/draft'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const rid = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface SampleView { n: number; sessionId: string; answerSeq: number; title: string; request: string; rating: number | null; exported: boolean; revised: boolean }
interface DraftView { draft: SkillDraft; role: string; samples: SampleView[]; sampleCount: number; thin: boolean; sources: Array<{ sessionId: string; answerSeq: number }>; oldBody?: string; name?: string }

// ───────── 看某一次对话（问题 + 最终回答），不离开当前窗口 ─────────
function SampleModal({ sample, onClose }: { sample: SampleView | null; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['skills', 'sample', sample?.sessionId], queryFn: () => window.api.agent.session(sample!.sessionId), enabled: !!sample })
  const steps: any[] = data?.steps ?? []
  const ans = steps.find(s => s.seq === sample?.answerSeq)
  const user = [...steps].filter(s => s.kind === 'user' && s.seq < (sample?.answerSeq ?? 0)).pop()
  return (
    <Modal open={!!sample} title={`第 ${sample?.n} 次对话`} onCancel={onClose} footer={<Btn tone="secondary" onClick={onClose}>关闭</Btn>} width={560} zIndex={1300} destroyOnClose>
      <div data-testid="skill-sample-view" style={{ display: 'grid', gap: 8 }}>
        <div className="ewb-lib-sub">你问的</div>
        <div style={{ whiteSpace: 'pre-wrap' }}>{user?.payload?.text ?? '…'}</div>
        <div className="ewb-lib-sub">助手的回答</div>
        <div style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto' }}>{ans?.payload?.text ?? '…'}</div>
      </div>
    </Modal>
  )
}

const supportText = (s: DraftStep): string => `${s.total} 次里 ${s.hit} 次${s.hit === s.total ? '都有' : '有'}`

// ───────── 从几次对话起草的审核页 / 更新对比 ─────────
export function DraftReview({ open, target, onClose, onSaved }: { open: boolean; target: { sessionId: string; seq: number } | { update: string } | null; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp()
  const [view, setView] = useState<DraftView | null>(null)
  const [d, setD] = useState<SkillDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [sample, setSample] = useState<SampleView | null>(null)
  const [tryState, setTryState] = useState<{ busy: boolean; res?: Awaited<ReturnType<typeof window.api.skills.tryRun>>; err?: string }>({ busy: false })
  const req = useRef('')
  const update = !!(target && 'update' in target)
  useEffect(() => {
    if (!open || !target) return
    let dead = false
    setView(null); setD(null); setErr(''); setTryState({ busy: false }); setLoading(true)
    const id = rid(); req.current = id
    const p = 'update' in target ? window.api.skills.draftUpdate(id, target.update) : window.api.skills.draft(id, target.sessionId, target.seq)
    p.then((v: DraftView) => { if (!dead) { setView(v); setD(v.draft) } }).catch(e => { if (!dead) setErr(clean(e)) }).finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true; void window.api.skills.cancel(id) }
  }, [open, target])
  const body = useMemo(() => (d ? composeBody(d) : ''), [d])
  // 只显示有改动的地方和它前后各一行（没变的大段用「……」代替），这样一眼能看到改了什么
  const diff = useMemo(() => {
    if (!update || !view?.oldBody) return []
    const all = lineDiff(view.oldBody, body)
    const keep = all.map((l, i) => l.type !== 'same' || all[i - 1]?.type === 'add' || all[i - 1]?.type === 'del' || all[i + 1]?.type === 'add' || all[i + 1]?.type === 'del')
    const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
    all.forEach((l, i) => { if (keep[i]) out.push(l); else if (out[out.length - 1]?.text !== '……') out.push({ type: 'same', text: '……' }) })
    return out
  }, [update, view, body])
  const set = (p: Partial<SkillDraft>) => setD(x => (x ? { ...x, ...p } : x))
  const setStep = (id: string, p: Partial<DraftStep>) => setD(x => (x ? { ...x, steps: x.steps.map(s => (s.id === id ? { ...s, ...p } : s)) } : x))
  const save = async () => {
    if (!d || !view) return
    try {
      const r = await window.api.skills.save({ draft: d, role: view.role, sources: view.sources, sampleCount: view.sampleCount, originalName: update ? view.name : undefined })
      message.success(update ? `已更新「${r.name}」，现在是第 ${r.version} 版（旧版本留在历史里）` : `已保存为 Skill「${r.name}」`, 5); r.warnings.forEach(w => message.warning(w, 6))
      onSaved(); onClose()
    } catch (e) { message.error(clean(e)) }
  }
  const tryIt = async () => {
    if (!d || !view) return
    const s = view.samples[0]
    setTryState({ busy: true })
    try { const res = await window.api.skills.tryRun({ reqId: rid(), sessionId: s.sessionId, answerSeq: s.answerSeq, role: view.role, draft: d }); setTryState({ busy: false, res }) } catch (e) { setTryState({ busy: false, err: clean(e) }) }
  }
  return (
    <Modal open={open} title={update ? '更新 Skill：对比旧版和新版' : '存成 Skill：看一看，改一改'} onCancel={onClose} width={760} destroyOnClose zIndex={1200}
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {d && view && <Btn tone="secondary" data-testid="skill-review-try" loading={tryState.busy} onClick={tryIt}>先试一次</Btn>}
        <Btn tone="secondary" onClick={onClose}>取消</Btn>
        <Btn tone="primary" data-testid="skill-review-save" disabled={!d || !d.name.trim() || (!d.steps.length && !d.output.trim())} onClick={save}>{update ? '更新到新版本' : '保存'}</Btn>
      </div>}>
      {loading && <div data-testid="skill-review-loading" style={{ textAlign: 'center', padding: 32 }}><Spin /><p className="ewb-lib-sub">助手正在对照这几次对话，整理成一份做事说明……</p></div>}
      {err && <p data-testid="skill-review-error" style={{ color: 'var(--ewb-red-ink)' }}>{err}</p>}
      {d && view && (
        <div data-testid="skill-review" style={{ display: 'grid', gap: 12, maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
          <div>
            <span className="ewb-lib-sub">参考了 {view.sampleCount} 次对话（点开可以看原文）：</span>{' '}
            {view.samples.map(s => <Tag key={s.n} bordered={false} style={{ cursor: 'pointer' }} data-testid="skill-review-sample" onClick={() => setSample(s)}>第 {s.n} 次 · {s.request.slice(0, 14) || s.title.slice(0, 14)}{s.rating === 1 ? ' 👍' : ''}{s.exported ? ' · 导出过' : ''}</Tag>)}
          </div>
          {view.thin && <div data-testid="skill-review-thin" style={{ background: 'var(--ewb-amber-bg, #fff7e6)', padding: '6px 10px', borderRadius: 6 }}>只根据 {view.sampleCount} 次对话，可能不够通用。多做几次同类的事再更新，会更准。</div>}
          {d.warnings.length > 0 && <ul className="ewb-lib-sub" data-testid="skill-review-warnings" style={{ margin: 0, paddingLeft: 18 }}>{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          {update && (
            <div data-testid="skill-diff" style={{ border: '1px solid var(--ewb-line, #eee)', borderRadius: 6, padding: 8, maxHeight: 220, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>
              <div className="ewb-lib-sub" style={{ fontFamily: 'inherit' }}>红色是旧版去掉的，绿色是新版加上的</div>
              {diff.map((l, i) => <div key={i} data-diff={l.type} style={{ whiteSpace: 'pre-wrap', background: l.type === 'add' ? '#e8f7ec' : l.type === 'del' ? '#fdecec' : undefined, textDecoration: l.type === 'del' ? 'line-through' : undefined, opacity: l.type === 'same' ? 0.6 : 1 }}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</div>)}
            </div>
          )}
          <label>名称<Input value={d.name} maxLength={40} data-testid="skill-review-name" onChange={e => set({ name: e.target.value })} disabled={update} /></label>
          <label>一句说明<Input value={d.description} maxLength={300} onChange={e => set({ description: e.target.value })} /></label>
          <label>什么时候用<Input value={d.when} maxLength={300} onChange={e => set({ when: e.target.value })} /></label>
          <div>
            <b>需要你告诉我</b><span className="ewb-lib-sub">（几次之间变了的东西；助手用的时候会先问你）</span>
            {d.params.length === 0 && <div className="ewb-lib-sub">没有。</div>}
            {d.params.map((p, i) => (
              <div key={i} data-testid="skill-review-param" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <Input style={{ width: 120 }} value={p.name} onChange={e => set({ params: d.params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input value={p.hint} placeholder="怎么问你" onChange={e => set({ params: d.params.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)) })} />
                <Btn tone="quiet" size="small" icon={X} onClick={() => set({ params: d.params.filter((_, j) => j !== i) })}>去掉</Btn>
              </div>
            ))}
          </div>
          <div>
            <b>做法</b><span className="ewb-lib-sub">（每一步后面写的是：这几次对话里有几次这样做）</span>
            {d.steps.map((s, i) => (
              <div key={s.id} data-testid="skill-review-step" data-tool={s.tool} data-hit={s.hit} data-total={s.total} style={{ display: 'grid', gap: 2, padding: '6px 0', borderBottom: '1px solid var(--ewb-line, #eee)' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="ewb-lib-sub">{i + 1}.</span>
                  <Input value={s.text} onChange={e => setStep(s.id, { text: e.target.value })} />
                  <Btn tone="quiet" size="small" icon={X} data-testid="skill-review-step-remove" onClick={() => set({ steps: d.steps.filter(x => x.id !== s.id) })}>去掉</Btn>
                </div>
                <div className="ewb-lib-sub" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Tag bordered={false} color={s.hit === s.total ? 'green' : 'orange'} data-testid="skill-review-support">{supportText(s)}{s.optional ? ' · 有时需要' : ''}</Tag>
                  {s.basis === 'claimed' && <span>（没有对应的查询，是助手归纳的）</span>}
                  {s.optional && <Input size="small" style={{ width: 220 }} value={s.condition} placeholder="什么情况下才需要？" onChange={e => setStep(s.id, { condition: e.target.value })} />}
                  <span>来自：</span>
                  {s.evidence.map(n => { const sm = view.samples.find(x => x.n === n); return sm ? <a key={n} data-testid="skill-review-evidence" onClick={() => setSample(sm)}>第 {n} 次</a> : null })}
                </div>
              </div>
            ))}
            {d.steps.length === 0 && <div className="ewb-lib-sub">没有可靠的步骤。</div>}
          </div>
          <label>输出格式<Input.TextArea rows={5} value={d.output} data-testid="skill-review-output" onChange={e => set({ output: e.target.value })} /></label>
          <label>做完检查（一行一条）<Input.TextArea rows={3} value={d.checklist.join('\n')} onChange={e => set({ checklist: e.target.value.split('\n').map(x => x.trim()).filter(Boolean) })} /></label>
          {tryState.err && <p style={{ color: 'var(--ewb-red-ink)' }}>{tryState.err}</p>}
          {tryState.res && (
            <div data-testid="skill-try-compare">
              <b>试跑对比</b><span className="ewb-lib-sub">（用第 1 次的问题试了一遍，只查数据，不会发送、不会生成文件）</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                <div><div className="ewb-lib-sub">原来的回答</div><div data-testid="skill-try-original" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', border: '1px solid var(--ewb-line, #eee)', borderRadius: 6, padding: 8 }}>{tryState.res.originalAnswer}</div></div>
                <div><div className="ewb-lib-sub">按这份 Skill 试跑的回答</div><div data-testid="skill-try-new" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', border: '1px solid var(--ewb-line, #eee)', borderRadius: 6, padding: 8 }}>{tryState.res.newAnswer}</div></div>
              </div>
              {tryState.res.blocked.length > 0 && <div className="ewb-lib-sub">试跑时没有开放这些会写文件或对外发送的功能，所以可能比原来少了那几步。</div>}
            </div>
          )}
        </div>
      )}
      <SampleModal sample={sample} onClose={() => setSample(null)} />
    </Modal>
  )
}

// ───────── 回答下面的一条：做得好 / 存成 Skill / 提示 ─────────
export function SkillBar({ sessionId, seq, running }: { sessionId: string; seq: number; running: boolean }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { data } = useQuery({ queryKey: ['skills', 'turn', sessionId, seq, running], queryFn: () => window.api.skills.turnInfo(sessionId, seq), staleTime: 0, enabled: !running })
  const [target, setTarget] = useState<{ sessionId: string; seq: number } | { update: string } | null>(null)
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['skills'] }); void qc.invalidateQueries({ queryKey: ['agent', 'playbooks'] }) }
  if (running || !data) return null
  const rate = async () => { try { await window.api.skills.rate(sessionId, seq, data.rating === 1 ? null : 1); refresh() } catch (e) { message.error(clean(e)) } }
  return (
    <div data-testid="skill-bar" style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="ewb-as-fork" data-testid="skill-like" aria-pressed={data.rating === 1} title="点一下，下次整理成 Skill 时会优先参考这次" onClick={rate} style={data.rating === 1 ? { color: 'var(--ewb-accent, #c2410c)', fontWeight: 600 } : undefined}>
          <ThumbsUp size={12} strokeWidth={1.9} style={{ verticalAlign: '-1px' }} /> {data.rating === 1 ? '已标记：做得好' : '这次做得好'}
        </button>
        <button type="button" className="ewb-as-fork" data-testid="skill-save-manual" title="把这类事存成 Skill，下次一键就能做" onClick={() => setTarget({ sessionId, seq })}>
          <Sparkles size={12} strokeWidth={1.9} style={{ verticalAlign: '-1px' }} /> 存成 Skill
        </button>
      </div>
      {data.create && (
        <div data-testid="skill-suggest" className="ewb-as-ask" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>这类事你已经做了 {data.create.count} 次（{data.create.label}），要不要存成 Skill？下次一键就能做。</span>
          <Btn tone="primary" size="small" data-testid="skill-suggest-save" onClick={() => setTarget({ sessionId, seq })}>存成 Skill</Btn>
          <Btn tone="quiet" size="small" data-testid="skill-suggest-dismiss" onClick={async () => { await window.api.skills.dismissCreate(sessionId, seq); refresh() }}>不用了</Btn>
        </div>
      )}
      {data.updates.map(u => (
        <div key={u.name} data-testid="skill-update-suggest" className="ewb-as-ask" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>最近 {u.count} 次你都{u.hint ? `改了「${u.hint}」` : '不太满意'}，要不要更新 Skill「{u.name}」？</span>
          <Btn tone="primary" size="small" data-testid="skill-update-open" onClick={() => setTarget({ update: u.name })}>看看新版</Btn>
          <Btn tone="quiet" size="small" data-testid="skill-update-dismiss" onClick={async () => { await window.api.skills.dismissUpdate(u.name); refresh() }}>先不用</Btn>
        </div>
      ))}
      <DraftReview open={!!target} target={target} onClose={() => setTarget(null)} onSaved={refresh} />
    </div>
  )
}

// ───────── Skill 列表里的版本 / 来源标注、历史版本 ─────────
export function SkillMetaLine({ name, onUpdate }: { name: string; onUpdate: () => void }) {
  const { data } = useQuery({ queryKey: ['skills', 'meta'], queryFn: () => window.api.skills.meta(), staleTime: 0 })
  const [hist, setHist] = useState(false)
  const m = data?.find(x => x.name === name)
  if (!m) return null
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid="skill-meta" data-name={name}>
      <Tag bordered={false} data-testid="skill-version">版本 {m.version}</Tag>
      {m.sampleCount > 0 && <span className="ewb-lib-sub">根据 {m.sampleCount} 次对话整理</span>}
      {m.thin && <Tag bordered={false} color="orange" data-testid="skill-thin">只根据 {m.sampleCount} 次对话，可能不够通用</Tag>}
      {m.update && <a data-testid="skill-update-hint" onClick={onUpdate}>最近 {m.update.count} 次都被改了{m.update.hint ? `（「${m.update.hint}」）` : ''}，看看新版</a>}
      {m.version > 1 && <a data-testid="skill-history" onClick={() => setHist(true)}>历史版本</a>}
      <VersionsModal open={hist} name={name} onClose={() => setHist(false)} />
    </div>
  )
}

function VersionsModal({ open, name, onClose }: { open: boolean; name: string; onClose: () => void }) {
  const { message, modal } = App.useApp()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['skills', 'versions', name], queryFn: () => window.api.skills.versions(name), enabled: open, staleTime: 0 })
  const [shown, setShown] = useState<{ v: number; text: string } | null>(null)
  const view = async (v: number) => setShown({ v, text: (await window.api.skills.versionText(name, v)) ?? '' })
  const restore = (v: number) => modal.confirm({
    title: `恢复到第 ${v} 版？`, content: '现在的内容会先存进历史，恢复后可以再换回来。', okText: '恢复', cancelText: '不恢复', zIndex: 1400,
    onOk: async () => { try { await window.api.skills.restore(name, v); void qc.invalidateQueries({ queryKey: ['skills'] }); void qc.invalidateQueries({ queryKey: ['agent', 'playbooks'] }); message.success('已恢复'); onClose() } catch (e) { message.error(clean(e)) } }
  })
  return (
    <Modal open={open} title={`「${name}」的历史版本`} onCancel={onClose} footer={<Btn tone="secondary" onClick={onClose}>关闭</Btn>} width={560} zIndex={1300} destroyOnClose>
      <div data-testid="skill-versions">
        {data.map(v => (
          <div key={v.version} data-testid="skill-version-row" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--ewb-line, #eee)' }}>
            <b>第 {v.version} 版</b>{v.current && <Tag bordered={false}>现在用的</Tag>}
            <span className="ewb-lib-sub">{v.at ? v.at.slice(0, 16).replace('T', ' ') : ''}</span><span style={{ flex: 1 }} />
            {!v.current && <><Btn tone="secondary" size="small" onClick={() => view(v.version)}>看内容</Btn><Btn tone="secondary" size="small" data-testid="skill-version-restore" onClick={() => restore(v.version)}>恢复这一版</Btn></>}
          </div>
        ))}
        {shown && <pre className="ewb-md__code" style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>{shown.text}</pre>}
      </div>
    </Modal>
  )
}

// ───────── 定制包（导出给同事 / 导入同事给的） ─────────
type PackList = Awaited<ReturnType<typeof window.api.pack.list>>
const KIND_LABEL: Record<string, string> = { role: '角色', skill: 'Skill', prompt: '提示词', connector: '外部连接' }
const STATUS_LABEL: Record<string, { t: string; c: string }> = { add: { t: '新增', c: 'green' }, replace: { t: '会替换', c: 'orange' }, same: { t: '相同', c: 'default' } }

export function PackPanel() {
  const { message } = App.useApp()
  const { data } = useQuery({ queryKey: ['pack', 'list'], queryFn: () => window.api.pack.list(), staleTime: 0 })
  const [sel, setSel] = useState<Record<string, string[]> | null>(null)
  const [imp, setImp] = useState<any>(null)
  const [keys, setKeys] = useState<string[]>([])
  const [result, setResult] = useState<any>(null)
  const cur = sel ?? (data ? { roles: data.roles.map(x => x.key), skills: data.skills.map(x => x.key), prompts: data.prompts.map(x => x.key), connectors: data.connectors.map(x => x.key) } : { roles: [], skills: [], prompts: [], connectors: [] })
  const total = cur.roles.length + cur.skills.length + cur.prompts.length + cur.connectors.length
  const group = (k: keyof PackList, label: string) => {
    const list = data?.[k] ?? []
    if (!list.length) return null
    return (
      <div data-testid={`pack-group-${k}`}>
        <b>{label}</b>
        <Checkbox.Group value={cur[k]} onChange={v => setSel({ ...cur, [k]: v as string[] })} style={{ display: 'grid', gap: 2, margin: '2px 0 6px 12px' }} options={list.map(x => ({ value: x.key, label: x.title }))} />
      </div>
    )
  }
  const doExport = async () => {
    try {
      const r = await window.api.pack.export(cur as any)
      if (r.saved) message.success(`已导出 ${r.count} 项，把这个文件发给同事就行；里面没有密钥、试卷、学员和对话`, 7)
      r.warnings.forEach(w => message.warning(w, 8))
    } catch (e) { message.error(clean(e)) }
  }
  const showPreview = (r: any) => {
    if (!r.picked) return
    if (!r.ok) { message.error(r.error); return }
    setImp(r); setResult(null); setKeys(r.items.filter((i: any) => i.selected && i.status !== 'same').map((i: any) => `${i.kind}:${i.key}`))
  }
  const pick = async () => { try { showPreview(await window.api.pack.importPick()) } catch (e) { message.error(clean(e)) } }
  const apply = async () => {
    try { setResult(await window.api.pack.importApply(imp.id, keys)); setImp((x: any) => ({ ...x, done: true })) } catch (e) { message.error(clean(e)) }
  }
  return (
    <div data-testid="pack-panel" style={{ display: 'grid', gap: 14 }}>
      <p className="ewb-lib-sub" style={{ margin: 0 }}>把你调好的角色、Skill 和外部连接的设置打成一个文件，发给同事；同事导入后就能直接用。文件里没有密钥，也没有试卷、学员信息和对话。</p>
      <div>
        <b>导出给同事用的配置包</b>
        <div style={{ display: 'grid', gap: 4, margin: '6px 0' }}>
          {total === 0 && !data?.roles.length && !data?.skills.length && !data?.prompts.length && !data?.connectors.length && <span className="ewb-lib-sub" data-testid="pack-empty">还没有可以导出的内容：先建一个角色或存一个 Skill。</span>}
          {group('roles', '我建的角色')}{group('skills', '我的 Skill')}{group('prompts', '改写过的提示词')}{group('connectors', '外部连接（只导设置，不导密钥）')}
        </div>
        <Btn tone="primary" size="small" data-testid="pack-export" disabled={total === 0} onClick={doExport}>导出给同事用的配置包</Btn>
      </div>
      <div>
        <b>导入同事给的配置包</b>
        <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>先看预览，你勾选的才会导入；导入只保存设置，不会运行任何东西。</p>
        <Btn tone="secondary" size="small" data-testid="pack-import" onClick={pick}>导入同事给的配置包</Btn>
      </div>
      <Modal open={!!imp} title="导入预览" width={640} zIndex={1200} destroyOnClose onCancel={() => setImp(null)}
        footer={imp?.done ? <Btn tone="primary" data-testid="pack-import-close" onClick={() => setImp(null)}>完成</Btn> : <><Btn tone="secondary" onClick={() => setImp(null)}>取消</Btn><Btn tone="primary" data-testid="pack-import-apply" disabled={!keys.length} onClick={apply}>导入勾选的 {keys.length} 项</Btn></>}>
        {imp && (
          <div data-testid="pack-preview" style={{ display: 'grid', gap: 6, maxHeight: '60vh', overflowY: 'auto' }}>
            {imp.dropped?.map((t: string, i: number) => <div key={i} className="ewb-lib-sub">{t}</div>)}
            {imp.items.length === 0 && <div className="ewb-lib-sub">这个包里什么都没有。</div>}
            {imp.items.map((it: any) => {
              const id = `${it.kind}:${it.key}`
              return (
                <div key={id} data-testid="pack-item" data-kind={it.kind} data-status={it.status} data-key={it.key} style={{ borderBottom: '1px solid var(--ewb-line, #eee)', padding: '6px 0' }}>
                  <Checkbox checked={keys.includes(id)} disabled={it.status === 'same' || imp.done} onChange={e => setKeys(k => (e.target.checked ? [...k, id] : k.filter(x => x !== id)))}>
                    <Tag bordered={false}>{KIND_LABEL[it.kind]}</Tag><b>{it.title}</b> <Tag bordered={false} color={STATUS_LABEL[it.status].c}>{STATUS_LABEL[it.status].t}</Tag>
                  </Checkbox>
                  <div className="ewb-lib-sub" style={{ marginLeft: 24 }}>{it.note}</div>
                  {it.detail && <div className="ewb-lib-sub" style={{ marginLeft: 24, fontFamily: 'ui-monospace, Menlo, monospace' }}>会运行的命令：{it.detail}</div>}
                </div>
              )
            })}
            {result && (
              <div data-testid="pack-result" style={{ background: '#e8f7ec', padding: 8, borderRadius: 6 }}>
                已导入：新增 {result.added} 项，替换 {result.replaced} 项，没导入 {result.skipped} 项。
                {result.needSecrets.length > 0 && <div>这几个外部连接还需要你自己填密钥或网址：{result.needSecrets.join('、')}（在「设置」里的连接处补上，再点测试连接）。</div>}
                {result.notes.map((n: string, i: number) => <div key={i}>{n}</div>)}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
