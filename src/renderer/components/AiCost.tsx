import React, { useEffect, useState } from 'react'
import { App, Collapse, Input, InputNumber, Table } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, UsageNote } from '../design'

const sym = (c: string) => (c === 'CNY' ? '¥' : c === 'USD' ? '$' : '')
const yuan = (n: number, c = 'CNY') => `${sym(c)}${Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)}${sym(c) ? '' : ' ' + c}`
const wan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : `${Math.max(1, Math.round(n / 100) * 100)}`)
type KindRow = { kind: string; label: string; calls: number; prompt: number; completion: number; money: number | null }
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 一行余额：「账户余额：¥12.34（刷新）去充值」；不支持 / 失败时给白话说明 */
function BalanceRow({ label, r, which, onRefresh, busy }: { label: string; r: AiBalance; which: 'text' | 'vision'; onRefresh: () => void; busy: boolean }) {
  const link = 'consoleUrl' in r && r.consoleUrl
  return (
    <div className="ewb-rep-row" style={{ gap: 8, alignItems: 'center' }} data-testid={`ai-balance-${which}`} data-status={r.status}>
      <b>{label}</b>
      {r.status === 'ok' && (
        <span data-testid="ai-balance-text" style={r.available ? undefined : { color: 'var(--ewb-bad, #c0392b)' }}>
          {r.text}{!r.available && '（不可用，请充值）'}{r.note ? <span className="ewb-rep-note">　{r.note}</span> : null}
        </span>
      )}
      {r.status !== 'ok' && <span className="ewb-rep-note" data-testid="ai-balance-msg">{r.message}</span>}
      {r.status !== 'nokey' && <Btn tone="quiet" size="small" loading={busy} data-testid="ai-balance-refresh" onClick={onRefresh}>刷新</Btn>}
      {link && <Btn tone="quiet" size="small" data-testid="ai-balance-topup" onClick={() => window.api.ai.openConsole(which)}>{r.status === 'ok' ? '去充值' : '打开控制台'}</Btn>}
    </div>
  )
}

/** 管理员自定义余额查询：公司自建平台 / 每个人额度不同时，按指定字段显示「这把密钥」的额度 */
function CustomBalanceForm({ onSaved }: { onSaved: () => void }) {
  const { message } = App.useApp()
  const { data } = useQuery({ queryKey: ['aiCustomBalance'], queryFn: () => window.api.ai.getCustomBalance(), staleTime: 0 })
  const [c, setC] = useState<AiCustomBalance>({ url: '', balancePath: '', totalPath: '', unit: '' })
  useEffect(() => { if (data) setC(data) }, [data])
  const save = async () => {
    try { await window.api.ai.setCustomBalance(c); message.success(c.url.trim() ? '已保存，余额将用这个地址查询' : '已清除自定义查询'); onSaved() } catch (e) { message.error(clean(e)) }
  }
  const f = (k: keyof AiCustomBalance, ph: string, w: number, tid: string) => <Input size="small" style={{ width: w }} placeholder={ph} value={c[k]} data-testid={tid} onChange={e => setC({ ...c, [k]: e.target.value })} />
  return (
    <Collapse ghost size="small" style={{ marginInlineStart: -12, marginTop: 6 }} items={[{
      key: 'custom', label: <span className="ewb-rep-collapse-label" data-testid="ai-custom-balance-toggle">自定义余额查询（管理员）</span>,
      children: (
        <div data-testid="ai-custom-balance">
          <p className="ewb-rep-note" style={{ margin: '0 0 6px' }}>公司自建的平台可以在这里指定怎么查额度：用同一把密钥以 GET 请求下面的地址，只读取你指定的字段（地址必须和 AI 服务地址是同一个主机）。填了就优先用它；清空地址即可恢复自动识别。</p>
          <div className="ewb-rep-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {f('url', '查询地址 https://…', 280, 'ai-custom-url')}
            {f('balancePath', '余额字段，如 data.balance', 170, 'ai-custom-balance-path')}
            {f('totalPath', '总额度字段（可选）', 150, 'ai-custom-total-path')}
            {f('unit', '单位，如 元', 80, 'ai-custom-unit')}
            <Btn tone="secondary" size="small" data-testid="ai-custom-save" onClick={save}>保存</Btn>
          </div>
        </div>
      )
    }]} />
  )
}

/** 设置 → AI 服务：账户余额 + 价格 */
export function AiBalancePanel() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data: bal } = useQuery({ queryKey: ['aiBalance'], queryFn: () => window.api.ai.balance(), staleTime: 30_000 })
  const { data: prices } = useQuery({ queryKey: ['aiPrices'], queryFn: () => window.api.ai.getPrices(), staleTime: 0 })
  const [pin, setPin] = useState<number | null>(null)
  const [pout, setPout] = useState<number | null>(null)
  useEffect(() => { if (prices) { setPin(prices.inPer1M); setPout(prices.outPer1M) } }, [prices])
  const refresh = async () => {
    setBusy(true)
    try { qc.setQueryData(['aiBalance'], await window.api.ai.balance(true)) } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }
  const savePrices = async () => {
    try { await window.api.ai.setPrices({ inPer1M: pin, outPer1M: pout }); qc.invalidateQueries({ queryKey: ['aiPrices'] }); qc.invalidateQueries({ queryKey: ['aiCost'] }); qc.invalidateQueries({ queryKey: ['usageByKind'] }); message.success('价格已保存') } catch (e) { message.error(clean(e)) }
  }
  return (
    <div style={{ marginTop: 12 }} data-testid="ai-balance-panel">
      {bal && <BalanceRow label="账户余额" r={bal.text} which="text" onRefresh={refresh} busy={busy} />}
      {bal?.vision && <BalanceRow label="视觉模型账户余额" r={bal.vision} which="vision" onRefresh={refresh} busy={busy} />}
      {bal && <p className="ewb-rep-note" style={{ margin: '4px 0 0' }}>服务商：{bal.providerName || '未识别'}</p>}
      <div className="ewb-rep-row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <b>价格（元 / 百万 token）</b>
        <span>输入</span><InputNumber size="small" min={0} max={100000} step={0.1} value={pin} onChange={v => setPin(v === null ? null : Number(v))} data-testid="ai-price-in" style={{ width: 90 }} />
        <span>输出</span><InputNumber size="small" min={0} max={100000} step={0.1} value={pout} onChange={v => setPout(v === null ? null : Number(v))} data-testid="ai-price-out" style={{ width: 90 }} />
        <Btn tone="secondary" size="small" data-testid="ai-price-save" onClick={savePrices}>保存价格</Btn>
      </div>
      <p className="ewb-rep-note" style={{ margin: '4px 0 0' }}>按服务商控制台上的价格填写，填了才能把 token 换算成金额；留空则只显示 token。</p>
      <CustomBalanceForm onSaved={() => { qc.invalidateQueries({ queryKey: ['aiCustomBalance'] }); void refresh() }} />
    </div>
  )
}

/** 设置 → AI 服务：本月用量（按任务类型）和上次实际花费 */
export function AiUsageByKind() {
  const { data: rows = [] } = useQuery({ queryKey: ['usageByKind'], queryFn: () => window.api.ai.usageByKind(), staleTime: 0 })
  const { data: last = [] } = useQuery({ queryKey: ['aiLastSpend'], queryFn: () => window.api.ai.lastSpend(), staleTime: 0 })
  const { data: prices } = useQuery({ queryKey: ['aiPrices'], queryFn: () => window.api.ai.getPrices(), staleTime: 0 })
  const priced = !!prices && prices.inPer1M !== null && prices.outPer1M !== null
  if (!rows.length && !last.length) return null
  return (
    <div style={{ marginTop: 12 }} data-testid="ai-usage-month">
      <b>本月用量</b>
      <Table<KindRow> size="small" pagination={false} rowKey="kind" dataSource={rows} style={{ marginTop: 6 }} columns={[
        { title: '任务', dataIndex: 'label' },
        { title: '调用次数', dataIndex: 'calls', width: 90 },
        { title: 'token（输入 + 输出）', width: 190, render: (_: unknown, r: KindRow) => `${wan(r.prompt)} + ${wan(r.completion)}` },
        ...(priced ? [{ title: '约合', width: 90, render: (_: unknown, r: KindRow) => (r.money === null ? '-' : yuan(r.money)) }] : [])
      ]} />
      {!priced && rows.length > 0 && <p className="ewb-rep-note" style={{ margin: '4px 0 0' }}>填写上面的价格，就能换算成金额。</p>}
      {last.length > 0 && <p className="ewb-rep-note" style={{ margin: '4px 0 0' }} data-testid="ai-last-spend">{last.map(l => `上次${l.label}实际花费约 ${yuan(l.amount, l.currency)}`).join('；')}（按前后余额之差，仅供参考；期间其他 AI 调用也会计入）</p>}
    </div>
  )
}

/**
 * 大任务开始前的用量提示：预计用量 / 约多少钱 / 当前余额 / 上次实际花费；估算可能超过余额时醒目提示。
 */
export function CostHint({ task, calls, fallbackTokens }: { task: 'course-match' | 'course-organize' | 'report'; calls: number; fallbackTokens?: number }) {
  const { data: est } = useQuery({ queryKey: ['aiCost', task, calls, fallbackTokens ?? 0], queryFn: () => window.api.ai.costEstimate({ task, calls, fallbackTokens }), staleTime: 5_000 })
  const { data: bal } = useQuery({ queryKey: ['aiBalance'], queryFn: () => window.api.ai.balance(), staleTime: 30_000 })
  if (!est) return null
  const b = bal?.text
  const ok = b && b.status === 'ok' ? b : null
  const priced = est.low !== null && est.high !== null
  const short = priced && ok && ok.currency === 'CNY' && ok.amount !== null && est.high! > ok.amount
  return (
    <span data-testid="cost-hint">
      <span className="ewb-rep-note" data-testid="cost-hint-main">
        {priced ? `预计花费约 ${yuan(est.low!)}–${yuan(est.high!)}（约 ${wan(est.tokens)} token${est.fromHistory ? '，按你以前的实际用量估算' : '，还没有历史用量，仅供参考'}）` : `预计约 ${wan(est.tokens)} token${est.fromHistory ? '（按以前的实际用量）' : ''}；在设置 → AI 服务里填写价格，可换算成金额`}
        {ok && `　当前余额 ${ok.unlimited ? '不限额度' : ok.text}`}
        {est.last && `　上次${est.label}实际花费约 ${yuan(est.last.amount, est.last.currency)}`}
        {est.last && <span style={{ fontSize: 12, opacity: 0.8 }}>（期间其他 AI 调用也会计入）</span>}
      </span>
      {short && <UsageNote kind="caution" data-testid="cost-hint-short">余额可能不够：预计最多花费 {yuan(est.high!)}，当前余额 {ok!.text}。</UsageNote>}
      {ok && !ok.available && <UsageNote kind="caution" data-testid="cost-hint-unavailable">当前账户余额不可用，请先充值。</UsageNote>}
    </span>
  )
}
