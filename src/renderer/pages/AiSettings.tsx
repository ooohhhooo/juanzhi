import React, { useEffect, useState } from 'react'
import { App, AutoComplete, Collapse, Form, Input, InputNumber, Select, Space, Switch, Table, Tooltip, Typography } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Panel, UsageNote } from '../design'
import '../design/page-report.css'
import { AiBalancePanel, AiUsageByKind } from '../components/AiCost'
import AiErrorExplain from '../components/AiErrorExplain'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type TestRow = AiTestItem & { kind: 'parse' | 'report' | 'vision'; label: string }
const STATUS_TEXT: Record<string, string> = { ok: '成功', warn: '能连通，但有疑问', fail: '失败', skip: '没有测' }

/** 模型名后面的小标签：快速 / 深度思考型（较慢）。模型档案来自主进程（预设里的按表，其余按名字猜） */
function SpeedTag({ model }: { model: string }) {
  const m = model.trim()
  const { data } = useQuery({ queryKey: ['modelProfile', m], queryFn: () => window.api.ai.modelProfile(m), enabled: !!m, staleTime: Infinity })
  if (!m || !data) return null
  return <span className={`ewb-set-pill${data.reasoning ? '' : ' ewb-set-pill--own'}`} data-testid="model-speed-tag" title={data.reasoning ? '会先思考再回答，拆一份卷子要等更久，也更容易写不完' : '直接回答，速度快'}>{data.reasoning ? '深度思考型（较慢）' : '快速'}</span>
}

export default function AiSettings() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const { data: presets = [] } = useQuery({ queryKey: ['aiPresets'], queryFn: () => window.api.ai.presets(), staleTime: Infinity })
  const { data: saved } = useQuery({ queryKey: ['aiConfig'], queryFn: () => window.api.ai.getConfig(), staleTime: 0 })
  const { data: usage = [] } = useQuery({ queryKey: ['usage'], queryFn: () => window.api.ai.usage() })

  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [key, setKey] = useState('')         // 只写：保存后立刻清空，界面永远读不回
  const [visionKey, setVisionKey] = useState('')   // 只写：视觉模型自己的密钥
  const [testing, setTesting] = useState<'all' | 'parse' | 'report' | 'vision' | null>(null)
  const [results, setResults] = useState<TestRow[] | null>(null)
  const [saving, setSaving] = useState(false)
  const { data: hint } = useQuery({ queryKey: ['modelHint'], queryFn: () => window.api.ai.modelHint(), staleTime: 0 })

  const parseModelName = cfg ? (cfg.parse_model.trim() || cfg.model).trim() : ''
  const { data: parseProfile } = useQuery({ queryKey: ['modelProfile', parseModelName], queryFn: () => window.api.ai.modelProfile(parseModelName), enabled: !!parseModelName, staleTime: Infinity })
  useEffect(() => { if (saved && !cfg) { const { hasKey, keyStorage, ...rest } = saved; setCfg(rest) } }, [saved, cfg])
  if (!cfg || !saved) return null

  const preset = presets.find(p => p.id === cfg.provider)
  // 明文 http 且不是本机：API Key 会在网络上明文传输
  const plainHttp = (() => { try { const u = new URL(cfg.base_url.trim()); return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.localhost') } catch { return false } })()
  const set = (patch: Partial<AiConfig>) => setCfg({ ...cfg, ...patch })
  const modelIsSlow = !!parseProfile?.reasoning

  const pickProvider = (id: string) => {
    const p = presets.find(x => x.id === id)
    if (!p) return
    set({ provider: id, ...(id === 'custom' ? {} : { base_url: p.baseUrl, model: p.model, parse_model: p.parseModel ?? '', vision_model: p.visionModel, vision_base_url: '' }) })
    setResults(null)
  }

  const save = async (clearKey = false) => {
    setSaving(true)
    try {
      const view = await window.api.ai.saveConfig(cfg, clearKey ? null : key.trim() ? key.trim() : undefined, visionKey.trim() ? visionKey.trim() : undefined)
      setKey('')
      setVisionKey('')
      queryClient.setQueryData(['aiConfig'], view)
      queryClient.invalidateQueries({ queryKey: ['queue'] })
      message.success(clearKey ? '已清除 API Key' : '已保存')
    } catch (e) {
      message.error(`保存失败：${clean(e)}`)
    } finally { setSaving(false) }
  }

  /** 用界面上还没保存的值测：地址 / 模型 / 密钥都以当前输入为准 */
  const draft = () => ({
    cfg: { base_url: cfg.base_url, model: cfg.model, parse_model: cfg.parse_model, vision_model: cfg.vision_model, vision_base_url: cfg.vision_base_url, timeout_sec: cfg.timeout_sec },
    apiKey: key.trim() || undefined, visionKey: visionKey.trim() || undefined
  })
  const testAll = async () => {
    setTesting('all'); setResults(null)
    try {
      const r = await window.api.ai.testAll(draft())
      setResults(r.items)
      queryClient.invalidateQueries({ queryKey: ['usage'] })
    } catch (e) { setResults([{ kind: 'parse', label: '测试', ok: false, status: 'fail', message: clean(e), latencyMs: 0, model: '' }]) }
    finally { setTesting(null) }
  }
  /** 只重测一项（视觉模型用旧接口：发带图的请求；拆题 / 写报告用文本请求） */
  const testOne = async (kind: 'parse' | 'report' | 'vision') => {
    setTesting(kind)
    try {
      const d = draft()
      // 拆题 / 写报告：把要测的那个模型当作文本模型测（拆题模型相同于 model 时二者是一回事）
      const r = await window.api.ai.test({ kind: kind === 'vision' ? 'vision' : 'text', cfg: kind === 'parse' ? { ...d.cfg, model: cfg.parse_model.trim() || cfg.model } : d.cfg, apiKey: d.apiKey, visionKey: d.visionKey })
      const row: TestRow = { ...r, kind, label: kind === 'vision' ? '视觉模型' : kind === 'parse' ? '拆题用的模型' : '写报告用的模型' }
      setResults(old => old ? old.map(x => x.kind === kind ? row : x) : [row])
      queryClient.invalidateQueries({ queryKey: ['usage'] })
    } catch (e) { setResults(old => (old ?? []).map(x => x.kind === kind ? { ...x, ok: false, status: 'fail' as const, message: clean(e) } : x)) }
    finally { setTesting(null) }
  }

  return (
    <div className="ewb-set-panel"><Panel title="AI 服务" data-testid="ai-settings">
      <UsageNote kind="tip">拆题与标注需要一个大模型服务（OpenAI 兼容接口）。API Key 只保存在本机并加密，界面和日志里都不会再显示它。</UsageNote>
      <Form layout="vertical" size="small">
        <Form.Item label="服务商">
          <Select data-testid="ai-provider" value={cfg.provider} onChange={pickProvider} options={presets.map(p => ({ label: p.name, value: p.id }))} />
          {preset?.keyHint && <div className="ewb-set-form-note">申请密钥：{preset.keyHint}</div>}
        </Form.Item>
        <Form.Item label="Base URL" extra="例如 https://api.deepseek.com ；程序会自动补上 /chat/completions">
          <Input data-testid="ai-base-url" value={cfg.base_url} onChange={e => set({ base_url: e.target.value, ...(preset && preset.id !== 'custom' && e.target.value !== preset.baseUrl ? { provider: 'custom' } : {}) })} placeholder="https://…" />
        </Form.Item>
        <div className="ewb-set-form-note" data-testid="ai-privacy-course" style={{ marginBottom: 12 }}>隐私：试卷内容、你上传的课程大纲，只会发给你在这里设置的 AI 服务，不会发给卷知开发者。</div>
        {plainHttp && <UsageNote kind="caution" data-testid="ai-http-warning">这个地址用的是不加密的 http：API Key 会在网络上明文传输，建议改用 https（本机/局域网自建服务除外）。</UsageNote>}
        {hint?.suggest && (
          <UsageNote kind="caution" title="拆题比较慢，建议换一个更快的模型" data-testid="model-hint"
            actions={<Space><Btn tone="secondary" data-testid="model-hint-dismiss" onClick={async () => { await window.api.ai.dismissModelHint(); queryClient.invalidateQueries({ queryKey: ['modelHint'] }) }}>以后不再提示</Btn></Space>}>
            你用的拆题模型 {hint.model}{hint.reasoning ? ' 是深度思考型' : ''}，最近 {hint.total} 批里有 {hint.retried} 批因为写不完被自动重试{hint.reason === 'slow' ? '，单批耗时也偏长' : ''}，拆一份卷子要等很久。
            建议在下面把「拆题用的模型」换成更快、不带深度思考的{hint.recommend ? `（比如 ${hint.recommend}）` : ''}。程序不会自己换模型，由你决定。
          </UsageNote>
        )}
        <Space style={{ width: '100%' }} align="start" wrap>
          <Form.Item label={<span>拆题用的模型 <SpeedTag model={cfg.parse_model.trim() || cfg.model} /></span>} style={{ width: 300 }}
            extra={<span data-testid="parse-model-hint">推荐用快速、不带深度思考的模型：拆题只是把卷子抄成题目，不需要“想”。留空 = 和右边写报告的模型一样。</span>}>
            <AutoComplete data-testid="ai-parse-model" style={{ width: '100%' }} value={cfg.parse_model} onChange={v => set({ parse_model: v })} options={(preset?.models ?? []).map(m => ({ value: m }))} placeholder={cfg.model ? `和写报告的一样（${cfg.model}）` : '模型名称'} />
          </Form.Item>
          <Form.Item label={<span>写报告用的模型 <SpeedTag model={cfg.model} /></span>} style={{ width: 300 }} extra="写考情分析、报告用，可以用更强的模型。">
            <AutoComplete data-testid="ai-model" style={{ width: '100%' }} value={cfg.model} onChange={v => set({ model: v })} options={(preset?.models ?? []).map(m => ({ value: m }))} placeholder="模型名称" />
          </Form.Item>
        </Space>
        {!hint?.suggest && (cfg.parse_model.trim() || cfg.model) && modelIsSlow && (
          <UsageNote kind="tip" data-testid="parse-model-slow-tip">
            现在拆题用的是“深度思考型”模型，一份卷子可能要等好几分钟，遇到“写不完”还会自动重试。想快一点，可以把「拆题用的模型」换成快速的{preset?.parseModel ? `（比如 ${preset.parseModel}）` : ''}。
          </UsageNote>
        )}
        <Form.Item label={<span>视觉模型（让 AI 直接看图读卷子） <SpeedTag model={cfg.vision_model} /></span>} style={{ maxWidth: 420 }} extra="用在照片、扫描件上本机识别不好的页。读图比读文字贵，默认只用在识别不好的页；页面图会发给下面这个服务商。">
          <AutoComplete data-testid="ai-vision-model" style={{ width: '100%' }} value={cfg.vision_model} onChange={v => set({ vision_model: v })} options={(preset?.models ?? []).map(m => ({ value: m }))} placeholder="可留空：留空则不使用读图" />
        </Form.Item>
        <Form.Item label="什么时候让 AI 读图" style={{ maxWidth: 520 }}>
          <Select data-testid="ai-vision-policy" value={cfg.vision_policy} onChange={v => set({ vision_policy: v })} options={[
            { value: 'auto', label: '只有本机识别不好的页才读图（推荐）' },
            { value: 'images_always', label: '图片和扫描件一律交给 AI 读图' },
            { value: 'never', label: '从不读图，只用本机识别' }
          ]} />
          {cfg.vision_policy === 'images_always' && <div className="ewb-set-form-note" data-testid="ai-vision-policy-note">选了这一项，每张图片、每页扫描件都会发给上面设置的 AI 服务商读图（更准，但更慢也更花钱，并且卷面内容会发给对方）。没装中文识别的 Windows 电脑可以选它。</div>}
          {cfg.vision_policy === 'never' && <div className="ewb-set-form-note">选了这一项，照片和扫描件只用本机识别的文字；中文识别不好的页不会改用 AI 读图。</div>}
        </Form.Item>
        <Collapse ghost size="small" items={[{
          key: 'vision-own', label: '视觉模型用不同的服务商 / 密钥（一般不用填）', children: (
            <div data-testid="ai-vision-own">
              <Form.Item label="视觉模型的服务地址" extra="留空 = 和上面的 Base URL 一样。例如文本模型用 DeepSeek、读图想用另一家时填这里。">
                <Input data-testid="ai-vision-base-url" value={cfg.vision_base_url} onChange={e => set({ vision_base_url: e.target.value })} placeholder="https://…（留空 = 同上）" />
              </Form.Item>
              <Form.Item label="视觉模型的 API Key" extra={saved.hasVisionKey ? '已单独保存（加密，不会再显示）。输入新值可替换；留空会一直用这把。' : '留空 = 沿用上面的 API Key。只有换了服务地址时才需要单独填。'}>
                <Space.Compact style={{ width: '100%' }}>
                  <Input.Password data-testid="ai-vision-key" autoComplete="off" value={visionKey} onChange={e => setVisionKey(e.target.value)} placeholder={saved.hasVisionKey ? '●●●●●●●●（已保存，输入新值可替换）' : '可留空'} visibilityToggle={false} />
                  {saved.hasVisionKey && <Btn tone="danger" data-testid="ai-vision-key-clear" onClick={async () => { await window.api.ai.saveConfig(cfg, undefined, null).then(v => queryClient.setQueryData(['aiConfig'], v)).catch(e => message.error(clean(e))); message.success('已清除视觉模型的 API Key') }}>清除</Btn>}
                </Space.Compact>
              </Form.Item>
            </div>
          )
        }]} />
        <Form.Item label="API Key" extra={saved.hasKey
          ? (saved.keyStorage === 'memory' ? '已设置（本机系统不支持加密存储，仅本次运行有效，重启后需重新输入）。输入新值可替换。' : '已设置并加密保存在本机。输入新值可替换；出于安全不会显示已保存的内容。')
          : '还没有设置。'}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password data-testid="ai-key" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={saved.hasKey ? '●●●●●●●●（已保存，输入新值可替换）' : 'sk-…'} visibilityToggle={false} />
            {saved.hasKey && <Btn tone="danger" onClick={() => save(true)}>清除</Btn>}
          </Space.Compact>
        </Form.Item>
        <Space size={24} wrap>
          <Form.Item label="同时解析的试卷数" style={{ marginBottom: 8 }}>
            <InputNumber data-testid="ai-concurrency" min={1} max={16} value={cfg.concurrency} onChange={v => set({ concurrency: v ?? 2 })} />
          </Form.Item>
          <Form.Item label="提取完成后自动开始解析" style={{ marginBottom: 8 }}>
            <Switch data-testid="ai-auto-parse" checked={cfg.auto_parse} onChange={v => set({ auto_parse: v })} />
          </Form.Item>
        </Space>
        <Collapse ghost size="small" items={[{
          key: 'adv', label: '高级', children: (
            <Space size={24} wrap>
              <Form.Item label="每批最多页数" extra="长卷分批发给模型"><InputNumber min={1} max={10} value={cfg.batch_pages} onChange={v => set({ batch_pages: v ?? 3 })} /></Form.Item>
              <Form.Item label="单次请求超时（秒）"><InputNumber min={2} max={600} value={cfg.timeout_sec} onChange={v => set({ timeout_sec: v ?? 180 })} /></Form.Item>
              <Form.Item label="AI 一次最多写多长" extra={cfg.max_tokens_auto
                ? '自动（推荐）：按所选模型决定。有的模型会在后台思考，思考也占额度（不显示出来），所以默认给得大；写不完时程序会自动加长，最多两次；如果服务商不接受更大的数，会自动降到 16384、再不行 8192 重试。'
                : '手动指定（单位 tokens）：从你填的数开始写，写不完时程序会自动加大，最多到 65536（或该模型的上限）。服务商不接受你填的数时不会替你改，请调低；一般建议保持「自动」。'}>
                <Space>
                  <Switch data-testid="ai-max-auto" checked={cfg.max_tokens_auto} checkedChildren="自动" unCheckedChildren="手动" onChange={v => set({ max_tokens_auto: v })} />
                  {!cfg.max_tokens_auto && <InputNumber data-testid="ai-max-tokens" min={1000} max={131072} step={1000} value={cfg.max_tokens} onChange={v => set({ max_tokens: v ?? 32768 })} />}
                  {!cfg.max_tokens_auto && cfg.max_tokens < 16384 && <Typography.Text type="warning" data-testid="ai-max-tokens-warn">这个数偏小，试卷内容多时容易写不完；建议 16384 以上，或改回「自动」。</Typography.Text>}
                </Space>
              </Form.Item>
            </Space>
          )
        }]} />
        <Space wrap style={{ marginTop: 12 }}>
          <Btn tone="primary" loading={saving} data-testid="ai-save" onClick={() => save()}>保存</Btn>
          <Btn tone="secondary" loading={testing === 'all'} data-testid="ai-test" onClick={testAll}>测试全部</Btn>
          <Btn tone="secondary" loading={testing === 'vision'} data-testid="ai-test-vision" disabled={!cfg.vision_model.trim()} onClick={() => testOne('vision')}>只测视觉模型</Btn>
        </Space>
        {results && (
          <UsageNote kind={results.some(r => r.status === 'fail') ? 'mistake' : results.some(r => r.status === 'warn') ? 'caution' : 'tip'} label={results.some(r => r.status === 'fail') ? '失败' : results.some(r => r.status === 'warn') ? '注意' : '成功'}
            data-testid="ai-test-result" title="测试结果">
            <ul className="ewb-set-testlist">
              {results.map(r => (
                <li key={r.kind} data-testid={`ai-test-row-${r.kind}`} data-status={r.status ?? (r.ok ? 'ok' : 'fail')}>
                  <b>{r.label}：{STATUS_TEXT[r.status ?? (r.ok ? 'ok' : 'fail')]}</b>
                  {r.model ? <span className="ewb-set-mono"> {r.model}</span> : null}
                  <div>{r.message}</div>
                  {r.status === 'fail' && r.steps && (
                    <ol className="ewb-set-steps" data-testid="ai-test-steps">{r.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
                  )}
                  {r.status === 'fail' && <AiErrorExplain message={r.message} task="test" nonce={`${r.kind}-${r.latencyMs}`} />}
                  {r.detail && <details><summary style={{ cursor: 'pointer' }}>查看详情（服务商返回的原话）</summary><div className="ewb-set-mono" style={{ wordBreak: 'break-all' }}>{r.detail}</div></details>}
                  {r.status !== 'skip' || r.kind !== 'report' ? <Btn tone="secondary" size="small" loading={testing === r.kind} onClick={() => testOne(r.kind)} data-testid={`ai-retest-${r.kind}`}>重测这一项</Btn> : null}
                </li>
              ))}
            </ul>
          </UsageNote>
        )}
      </Form>
      <AiBalancePanel />
      <p className="ewb-rep-note" style={{ marginTop: 12 }}>
        模型名称以服务商控制台为准，会随服务商更新。注意：DeepSeek 已在 2026 年 7 月下线 deepseek-chat，请不要再使用。
      </p>
      <AiUsageByKind />
      {usage.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>累计 token 用量</b>
          <Table size="small" pagination={false} rowKey="model" dataSource={usage} style={{ marginTop: 6 }} columns={[
            { title: '模型', dataIndex: 'model' },
            { title: '调用次数', dataIndex: 'calls', width: 90 },
            { title: '输入', dataIndex: 'prompt', width: 100, render: (v: number) => v.toLocaleString() },
            { title: <Tooltip title="命中服务商前缀缓存的输入，通常更便宜">其中缓存命中</Tooltip>, dataIndex: 'cached', width: 120, render: (v: number) => v.toLocaleString() },
            { title: '输出', dataIndex: 'completion', width: 100, render: (v: number) => v.toLocaleString() },
            { title: '失败', dataIndex: 'failed', width: 70, render: (v: number) => (v ? <span className="ewb-set-pill ewb-set-pill--bad" style={{ marginInlineStart: 0 }}>{v}</span> : '-') }
          ]} />
        </div>
      )}
    </Panel></div>
  )
}
