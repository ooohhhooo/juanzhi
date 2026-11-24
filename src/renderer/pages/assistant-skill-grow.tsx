import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, Checkbox, Input, Modal, Spin } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleCheck, Info, RefreshCw, ThumbsUp, Sparkles, X } from 'lucide-react'
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
    <Modal open={!!sample} title={`第 ${sample?.n} 次对话`} onCancel={onClose} footer={<Btn tone="secondary" onClick={onClose}>关闭</Btn>} width={560} zIndex={1300} destroyOnClose rootClassName="ewb-as-modal">
      <div data-testid="skill-sample-view" className="ewb-as-form">
        <div className="ewb-as-field"><span className="ewb-as-field__k">你问的</span><div style={{ whiteSpace: 'pre-wrap' }}>{user?.payload?.text ?? '…'}</div></div>
        <div className="ewb-as-field"><span className="ewb-as-field__k">助手的回答</span><div className="ewb-as-compare__box" style={{ maxHeight: 'none' }}>{ans?.payload?.text ?? '…'}</div></div>
      </div>
    </Modal>
  )
}

const supportText = (s: DraftStep): string => `${s.total} 次里 ${s.hit} 次${s.hit === s.total ? '都有' : '有'}`

/** 表单里的一项：上面一行标签（可带说明），下面是控件 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="ewb-as-field"><span className="ewb-as-field__k">{label}{hint && <small>{hint}</small>}</span>{children}</label>
}

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
    <Modal open={open} title={update ? '更新 Skill：对比旧版和新版' : '存成 Skill：看一看，改一改'} onCancel={onClose} width={760} destroyOnClose zIndex={1200} rootClassName="ewb-as-modal"
      footer={<div className="ewb-as-foot">
        {d && view && <Btn tone="secondary" icon={RefreshCw} data-testid="skill-review-try" loading={tryState.busy} onClick={tryIt} style={{ marginRight: 'auto' }}>先试一次</Btn>}
        <Btn tone="secondary" onClick={onClose}>取消</Btn>
        <Btn tone="primary" data-testid="skill-review-save" disabled={!d || !d.name.trim() || (!d.steps.length && !d.output.trim())} onClick={save}>{update ? '更新到新版本' : '保存'}</Btn>
      </div>}>
      {loading && <div className="ewb-as-loading" data-testid="skill-review-loading"><Spin /><span>助手正在对照这几次对话，整理成一份做事说明……</span></div>}
      {err && <p className="ewb-as-err" data-testid="skill-review-error">{err}</p>}
      {d && view && (
        <div data-testid="skill-review" className="ewb-as-form">
          <div className="ewb-as-field">
            <span className="ewb-as-field__k">参考了 {view.sampleCount} 次对话<small>点开可以看原文</small></span>
            <div className="ewb-as-pills">
              {view.samples.map(s => <button type="button" key={s.n} className="ewb-as-pill ewb-as-pill--soft" data-testid="skill-review-sample" title={s.request || s.title} onClick={() => setSample(s)}>第 {s.n} 次 · {s.request.slice(0, 14) || s.title.slice(0, 14)}{s.rating === 1 ? <ThumbsUp size={12} strokeWidth={2} aria-label="做得好" /> : null}{s.exported ? ' · 导出过' : ''}</button>)}
            </div>
          </div>
          {view.thin && <div className="ewb-as-callout" data-testid="skill-review-thin"><Info size={15} strokeWidth={1.9} aria-hidden /><span>只根据 {view.sampleCount} 次对话，可能不够通用。多做几次同类的事再更新，会更准。</span></div>}
          {d.warnings.length > 0 && <div className="ewb-as-callout"><Info size={15} strokeWidth={1.9} aria-hidden /><ul data-testid="skill-review-warnings">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
          {update && (
            <div className="ewb-as-field">
              <span className="ewb-as-field__k">改了什么<small>前面是「-」的是旧版去掉的，「+」的是新版加上的</small></span>
              <div className="ewb-as-diff" data-testid="skill-diff">
                {diff.map((l, i) => <div key={i} data-diff={l.type}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</div>)}
              </div>
            </div>
          )}
          <Field label="名称"><Input value={d.name} maxLength={40} data-testid="skill-review-name" onChange={e => set({ name: e.target.value })} disabled={update} /></Field>
          <Field label="一句说明"><Input value={d.description} maxLength={300} onChange={e => set({ description: e.target.value })} /></Field>
          <Field label="什么时候用"><Input value={d.when} maxLength={300} onChange={e => set({ when: e.target.value })} /></Field>
          <div className="ewb-as-sec">
            <p className="ewb-as-sec__h">需要你告诉我<small>几次之间变了的东西；助手用的时候会先问你</small></p>
            {d.params.length === 0 && <div className="ewb-as-muted">没有。</div>}
            {d.params.map((p, i) => (
              <div key={i} className="ewb-as-param" data-testid="skill-review-param">
                <Input style={{ width: 140, flex: 'none' }} value={p.name} aria-label="要问的东西" onChange={e => set({ params: d.params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input value={p.hint} placeholder="怎么问你" aria-label="怎么问你" onChange={e => set({ params: d.params.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)) })} />
                <Btn tone="quiet" size="small" icon={X} onClick={() => set({ params: d.params.filter((_, j) => j !== i) })}>去掉</Btn>
              </div>
            ))}
          </div>
          <div className="ewb-as-sec">
            <p className="ewb-as-sec__h">做法<small>每一步后面写的是：这几次对话里有几次这样做</small></p>
            <div className="ewb-as-steps">
              {d.steps.map((s, i) => (
                <div key={s.id} className="ewb-as-step" data-testid="skill-review-step" data-tool={s.tool} data-hit={s.hit} data-total={s.total}>
                  <div className="ewb-as-step__row">
                    <span className="ewb-as-step__n">{i + 1}.</span>
                    <Input value={s.text} aria-label={`第 ${i + 1} 步`} onChange={e => setStep(s.id, { text: e.target.value })} />
                    <Btn tone="quiet" size="small" icon={X} data-testid="skill-review-step-remove" onClick={() => set({ steps: d.steps.filter(x => x.id !== s.id) })}>去掉</Btn>
                  </div>
                  <div className="ewb-as-step__meta">
                    <span className={`ewb-as-pill${s.hit === s.total ? '' : ' ewb-as-pill--dashed'}`} data-testid="skill-review-support">{s.hit === s.total && <Check size={12} strokeWidth={2.2} aria-hidden />}{supportText(s)}{s.optional ? ' · 有时需要' : ''}</span>
                    {s.basis === 'claimed' && <span>没有对应的查询，是助手归纳的</span>}
                    {s.optional && <Input size="small" style={{ width: 220 }} value={s.condition} placeholder="什么情况下才需要？" onChange={e => setStep(s.id, { condition: e.target.value })} />}
                    <span>来自</span>
                    {s.evidence.map(n => { const sm = view.samples.find(x => x.n === n); return sm ? <button type="button" key={n} className="ewb-as-chiplink" data-testid="skill-review-evidence" onClick={() => setSample(sm)}>第 {n} 次</button> : null })}
                  </div>
                </div>
              ))}
            </div>
            {d.steps.length === 0 && <div className="ewb-as-muted">没有可靠的步骤。</div>}
          </div>
          <div className="ewb-as-sec">
            <Field label="输出格式"><Input.TextArea rows={5} value={d.output} data-testid="skill-review-output" onChange={e => set({ output: e.target.value })} /></Field>
            <Field label="做完检查" hint="一行一条"><Input.TextArea rows={3} value={d.checklist.join('\n')} onChange={e => set({ checklist: e.target.value.split('\n').map(x => x.trim()).filter(Boolean) })} /></Field>
          </div>
          {tryState.err && <p className="ewb-as-err">{tryState.err}</p>}
          {tryState.res && (
            <div className="ewb-as-sec" data-testid="skill-try-compare">
              <p className="ewb-as-sec__h">试跑对比<small>用第 1 次的问题试了一遍，只查数据，不会发送、不会生成文件</small></p>
              <div className="ewb-as-compare">
                <div className="ewb-as-compare__col"><span className="ewb-as-muted">原来的回答</span><div className="ewb-as-compare__box" data-testid="skill-try-original">{tryState.res.originalAnswer}</div></div>
                <div className="ewb-as-compare__col ewb-as-compare__col--new"><span className="ewb-as-muted">按这份 Skill 试跑的回答</span><div className="ewb-as-compare__box" data-testid="skill-try-new">{tryState.res.newAnswer}</div></div>
              </div>
              {tryState.res.blocked.length > 0 && <div className="ewb-as-muted">试跑时没有开放这些会写文件或对外发送的功能，所以可能比原来少了那几步。</div>}
            </div>
          )}
        </div>
      )}
      <SampleModal sample={sample} onClose={() => setSample(null)} />
    </Modal>
  )
}

// ───────── 回答下面的一排：从这里追问（lead）/ 做得好 / 存成 Skill / 提示 ─────────
export function SkillBar({ sessionId, seq, running, lead }: { sessionId: string; seq: number; running: boolean; lead?: React.ReactNode }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { data } = useQuery({ queryKey: ['skills', 'turn', sessionId, seq, running], queryFn: () => window.api.skills.turnInfo(sessionId, seq), staleTime: 0, enabled: !running })
  const [target, setTarget] = useState<{ sessionId: string; seq: number } | { update: string } | null>(null)
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['skills'] }); void qc.invalidateQueries({ queryKey: ['agent', 'playbooks'] }) }
  if (running) return null
  if (!data) return lead ? <div className="ewb-as-answer__foot">{lead}</div> : null
  const rate = async () => { try { await window.api.skills.rate(sessionId, seq, data.rating === 1 ? null : 1); refresh() } catch (e) { message.error(clean(e)) } }
  return (
    <div className="ewb-as-answer__foot">
      <div className="ewb-as-skillbar" data-testid="skill-bar">
        <div className="ewb-as-skillbar__row">
          {lead}
          <button type="button" className="ewb-as-fork" data-testid="skill-like" aria-pressed={data.rating === 1} title="点一下，下次整理成 Skill 时会优先参考这次" onClick={rate}>
            <ThumbsUp size={13} strokeWidth={1.9} aria-hidden />{data.rating === 1 ? '已标记：做得好' : '这次做得好'}
          </button>
          <button type="button" className="ewb-as-fork" data-testid="skill-save-manual" title="把这类事存成 Skill，下次一键就能做" onClick={() => setTarget({ sessionId, seq })}>
            <Sparkles size={13} strokeWidth={1.9} aria-hidden />存成 Skill
          </button>
        </div>
        {data.create && (
          <div data-testid="skill-suggest" className="ewb-as-suggestbar">
            <Sparkles size={16} strokeWidth={1.9} aria-hidden />
            <span className="ewb-as-suggestbar__t">这类事你已经做了 {data.create.count} 次（{data.create.label}），要不要存成 Skill？下次一键就能做。</span>
            <span className="ewb-as-suggestbar__acts">
              <Btn tone="quiet" size="small" data-testid="skill-suggest-dismiss" onClick={async () => { await window.api.skills.dismissCreate(sessionId, seq); refresh() }}>不用了</Btn>
              <Btn tone="primary" size="small" data-testid="skill-suggest-save" onClick={() => setTarget({ sessionId, seq })}>存成 Skill</Btn>
            </span>
          </div>
        )}
        {data.updates.map(u => (
          <div key={u.name} data-testid="skill-update-suggest" className="ewb-as-suggestbar">
            <RefreshCw size={16} strokeWidth={1.9} aria-hidden />
            <span className="ewb-as-suggestbar__t">最近 {u.count} 次你都{u.hint ? `改了「${u.hint}」` : '不太满意'}，要不要更新 Skill「{u.name}」？</span>
            <span className="ewb-as-suggestbar__acts">
              <Btn tone="quiet" size="small" data-testid="skill-update-dismiss" onClick={async () => { await window.api.skills.dismissUpdate(u.name); refresh() }}>先不用</Btn>
              <Btn tone="primary" size="small" data-testid="skill-update-open" onClick={() => setTarget({ update: u.name })}>看看新版</Btn>
            </span>
          </div>
        ))}
      </div>
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
    <div className="ewb-as-pills" data-testid="skill-meta" data-name={name}>
      <span className="ewb-as-pill" data-testid="skill-version">版本 {m.version}</span>
      {m.sampleCount > 0 && <span className="ewb-as-muted">根据 {m.sampleCount} 次对话整理</span>}
      {m.thin && <span className="ewb-as-pill ewb-as-pill--dashed" data-testid="skill-thin">只根据 {m.sampleCount} 次对话，可能不够通用</span>}
      {m.update && <button type="button" className="ewb-as-chiplink" data-testid="skill-update-hint" onClick={onUpdate}>最近 {m.update.count} 次都被改了{m.update.hint ? `（「${m.update.hint}」）` : ''}，看看新版</button>}
      {m.version > 1 && <button type="button" className="ewb-as-chiplink" data-testid="skill-history" onClick={() => setHist(true)}>历史版本</button>}
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
    <Modal open={open} title={`「${name}」的历史版本`} onCancel={onClose} footer={<Btn tone="secondary" onClick={onClose}>关闭</Btn>} width={560} zIndex={1300} destroyOnClose rootClassName="ewb-as-modal">
      <div data-testid="skill-versions">
        <div className="ewb-as-list">
          {data.map(v => (
            <div key={v.version} data-testid="skill-version-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <b>第 {v.version} 版</b>{v.current && <span className="ewb-as-pill ewb-as-pill--primary">现在用的</span>}
              <span className="ewb-as-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{v.at ? v.at.slice(0, 16).replace('T', ' ') : ''}</span><span style={{ flex: 1 }} />
              {!v.current && <><Btn tone="quiet" size="small" onClick={() => view(v.version)}>看内容</Btn><Btn tone="secondary" size="small" data-testid="skill-version-restore" onClick={() => restore(v.version)}>恢复这一版</Btn></>}
            </div>
          ))}
        </div>
        {shown && <pre className="ewb-as-pre" style={{ marginTop: 12 }}>{shown.text}</pre>}
      </div>
    </Modal>
  )
}

// ───────── 定制包（导出给同事 / 导入同事给的） ─────────
type PackList = Awaited<ReturnType<typeof window.api.pack.list>>
const KIND_LABEL: Record<string, string> = { role: '角色', skill: 'Skill', prompt: '提示词', connector: '外部连接' }
/** 新增：紫色细线；会替换：虚线（要留意）；相同：灰色、不能勾 */
const STATUS_LABEL: Record<string, { t: string; cls: string }> = { add: { t: '新增', cls: 'ewb-as-pill--primary' }, replace: { t: '会替换', cls: 'ewb-as-pill--dashed' }, same: { t: '相同', cls: 'ewb-as-pill--soft' } }

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
      <div data-testid={`pack-group-${k}`} className="ewb-as-field">
        <span className="ewb-as-field__k">{label}</span>
        <Checkbox.Group value={cur[k]} onChange={v => setSel({ ...cur, [k]: v as string[] })} style={{ display: 'grid', gap: 4, marginLeft: 2 }} options={list.map(x => ({ value: x.key, label: x.title }))} />
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
    <div data-testid="pack-panel" className="ewb-as-form">
      <p className="ewb-lib-sub" style={{ margin: 0 }}>把你调好的角色、Skill 和外部连接的设置打成一个文件，发给同事；同事导入后就能直接用。文件里没有密钥，也没有试卷、学员信息和对话。</p>
      <div className="ewb-as-sec">
        <p className="ewb-as-sec__h">导出给同事用的配置包</p>
        <div className="ewb-as-form" style={{ gap: 12 }}>
          {total === 0 && !data?.roles.length && !data?.skills.length && !data?.prompts.length && !data?.connectors.length && <span className="ewb-as-muted" data-testid="pack-empty">还没有可以导出的内容：先建一个角色或存一个 Skill。</span>}
          {group('roles', '我建的角色')}{group('skills', '我的 Skill')}{group('prompts', '改写过的提示词')}{group('connectors', '外部连接（只导设置，不导密钥）')}
        </div>
        <div><Btn tone="primary" size="small" data-testid="pack-export" disabled={total === 0} onClick={doExport}>导出给同事用的配置包</Btn></div>
      </div>
      <div className="ewb-as-sec">
        <p className="ewb-as-sec__h">导入同事给的配置包</p>
        <p className="ewb-as-muted" style={{ margin: 0 }}>先看预览，你勾选的才会导入；导入只保存设置，不会运行任何东西。</p>
        <div><Btn tone="secondary" size="small" data-testid="pack-import" onClick={pick}>导入同事给的配置包</Btn></div>
      </div>
      <Modal open={!!imp} title="导入预览" width={640} zIndex={1200} destroyOnClose onCancel={() => setImp(null)} rootClassName="ewb-as-modal"
        footer={<div className="ewb-as-foot">{imp?.done ? <Btn tone="primary" data-testid="pack-import-close" onClick={() => setImp(null)}>完成</Btn> : <><Btn tone="secondary" onClick={() => setImp(null)}>取消</Btn><Btn tone="primary" data-testid="pack-import-apply" disabled={!keys.length} onClick={apply}>导入勾选的 {keys.length} 项</Btn></>}</div>}>
        {imp && (
          <div data-testid="pack-preview" className="ewb-as-form" style={{ gap: 12 }}>
            {imp.dropped?.map((t: string, i: number) => <div key={i} className="ewb-as-muted">{t}</div>)}
            {imp.items.length === 0 && <div className="ewb-as-muted">这个包里什么都没有。</div>}
            <div className="ewb-as-list">
              {imp.items.map((it: any) => {
                const id = `${it.kind}:${it.key}`
                const st = STATUS_LABEL[it.status]
                return (
                  <div key={id} data-testid="pack-item" data-kind={it.kind} data-status={it.status} data-key={it.key}>
                    <Checkbox checked={keys.includes(id)} disabled={it.status === 'same' || imp.done} onChange={e => setKeys(k => (e.target.checked ? [...k, id] : k.filter(x => x !== id)))}>
                      <span className="ewb-as-pills" style={{ display: 'inline-flex' }}><span className="ewb-as-pill ewb-as-pill--soft">{KIND_LABEL[it.kind]}</span><b>{it.title}</b><span className={`ewb-as-pill ${st.cls}`}>{st.t}</span></span>
                    </Checkbox>
                    <div className="ewb-as-muted" style={{ marginLeft: 24, marginTop: 4 }}>{it.note}</div>
                    {it.detail && <div className="ewb-as-muted" style={{ marginLeft: 24, marginTop: 4 }}>会运行的命令：<code className="ewb-as-code">{it.detail}</code></div>}
                  </div>
                )
              })}
            </div>
            {result && (
              <div className="ewb-as-callout ewb-as-callout--done" data-testid="pack-result">
                <CircleCheck size={15} strokeWidth={1.9} aria-hidden />
                <div>
                  已导入：新增 {result.added} 项，替换 {result.replaced} 项，没导入 {result.skipped} 项。
                  {result.needSecrets.length > 0 && <div>这几个外部连接还需要你自己填密钥或网址：{result.needSecrets.join('、')}（在「设置」里的连接处补上，再点测试连接）。</div>}
                  {result.notes.map((n: string, i: number) => <div key={i}>{n}</div>)}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
