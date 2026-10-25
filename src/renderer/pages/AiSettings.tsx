import React, { useEffect, useState } from 'react'
import { App, AutoComplete, Alert, Button, Card, Collapse, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Tooltip } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function AiSettings() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const { data: presets = [] } = useQuery({ queryKey: ['aiPresets'], queryFn: () => window.api.ai.presets(), staleTime: Infinity })
  const { data: saved } = useQuery({ queryKey: ['aiConfig'], queryFn: () => window.api.ai.getConfig(), staleTime: 0 })
  const { data: usage = [] } = useQuery({ queryKey: ['usage'], queryFn: () => window.api.ai.usage() })

  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [key, setKey] = useState('')         // 只写：保存后立刻清空，界面永远读不回
  const [testing, setTesting] = useState<'text' | 'vision' | null>(null)
  const [result, setResult] = useState<{ kind: 'text' | 'vision'; ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (saved && !cfg) { const { hasKey, keyStorage, ...rest } = saved; setCfg(rest) } }, [saved, cfg])
  if (!cfg || !saved) return null

  const preset = presets.find(p => p.id === cfg.provider)
  // 明文 http 且不是本机：API Key 会在网络上明文传输
  const plainHttp = (() => { try { const u = new URL(cfg.base_url.trim()); return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.localhost') } catch { return false } })()
  const set = (patch: Partial<AiConfig>) => setCfg({ ...cfg, ...patch })

  const pickProvider = (id: string) => {
    const p = presets.find(x => x.id === id)
    if (!p) return
    set({ provider: id, ...(id === 'custom' ? {} : { base_url: p.baseUrl, model: p.model, vision_model: p.visionModel }) })
    setResult(null)
  }

  const save = async (clearKey = false) => {
    setSaving(true)
    try {
      const view = await window.api.ai.saveConfig(cfg, clearKey ? null : key.trim() ? key.trim() : undefined)
      setKey('')
      queryClient.setQueryData(['aiConfig'], view)
      queryClient.invalidateQueries({ queryKey: ['queue'] })
      message.success(clearKey ? '已清除 API Key' : '已保存')
    } catch (e) {
      message.error(`保存失败：${clean(e)}`)
    } finally { setSaving(false) }
  }

  const test = async (kind: 'text' | 'vision') => {
    setTesting(kind); setResult(null)
    try {
      // 用界面上还没保存的值测：地址/模型/密钥都以当前输入为准
      const r = await window.api.ai.test({ kind, cfg: { base_url: cfg.base_url, model: cfg.model, vision_model: cfg.vision_model, timeout_sec: cfg.timeout_sec }, apiKey: key.trim() || undefined })
      setResult({ kind, ok: r.ok, message: r.message })
      queryClient.invalidateQueries({ queryKey: ['usage'] })
    } catch (e) { setResult({ kind, ok: false, message: clean(e) }) }
    finally { setTesting(null) }
  }

  return (
    <Card title="AI 服务" size="small" style={{ marginBottom: 16 }} data-testid="ai-settings">
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="拆题与标注需要一个 OpenAI 兼容的大模型服务。API Key 只保存在本机并加密，界面和日志里都不会再显示它。" />
      <Form layout="vertical" size="small">
        <Form.Item label="服务商">
          <Select data-testid="ai-provider" value={cfg.provider} onChange={pickProvider} options={presets.map(p => ({ label: p.name, value: p.id }))} />
          {preset?.keyHint && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>申请密钥：{preset.keyHint}</div>}
        </Form.Item>
        <Form.Item label="Base URL" extra="例如 https://api.deepseek.com ；程序会自动补上 /chat/completions">
          <Input data-testid="ai-base-url" value={cfg.base_url} onChange={e => set({ base_url: e.target.value, ...(preset && preset.id !== 'custom' && e.target.value !== preset.baseUrl ? { provider: 'custom' } : {}) })} placeholder="https://…" />
        </Form.Item>
        {plainHttp && <Alert data-testid="ai-http-warning" type="warning" showIcon style={{ marginBottom: 12 }} message="这个地址用的是不加密的 http：API Key 会在网络上明文传输，建议改用 https（本机/局域网自建服务除外）。" />}
        <Space style={{ width: '100%' }} align="start" wrap>
          <Form.Item label="文本模型（拆题、标注）" style={{ width: 280 }}>
            <AutoComplete data-testid="ai-model" style={{ width: '100%' }} value={cfg.model} onChange={v => set({ model: v })} options={(preset?.models ?? []).map(m => ({ value: m }))} placeholder="模型名称" />
          </Form.Item>
          <Form.Item label="视觉模型（OCR 失败或扫描质量差时读图）" style={{ width: 320 }}>
            <AutoComplete data-testid="ai-vision-model" style={{ width: '100%' }} value={cfg.vision_model} onChange={v => set({ vision_model: v })} options={(preset?.models ?? []).map(m => ({ value: m }))} placeholder="可留空：留空则不使用读图" />
          </Form.Item>
        </Space>
        <Form.Item label="API Key" extra={saved.hasKey
          ? (saved.keyStorage === 'memory' ? '已设置（本机系统不支持加密存储，仅本次运行有效，重启后需重新输入）。输入新值可替换。' : '已设置并加密保存在本机。输入新值可替换；出于安全不会显示已保存的内容。')
          : '还没有设置。'}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password data-testid="ai-key" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={saved.hasKey ? '●●●●●●●●（已保存，输入新值可替换）' : 'sk-…'} visibilityToggle={false} />
            {saved.hasKey && <Button danger onClick={() => save(true)}>清除</Button>}
          </Space.Compact>
        </Form.Item>
        <Space size={24} wrap>
          <Form.Item label="同时解析的试卷数" style={{ marginBottom: 8 }}>
            <InputNumber data-testid="ai-concurrency" min={1} max={4} value={cfg.concurrency} onChange={v => set({ concurrency: v ?? 2 })} />
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
              <Form.Item label="输出长度上限（tokens）" extra="服务商限制更小时请调低"><InputNumber min={1000} max={64000} step={1000} value={cfg.max_tokens} onChange={v => set({ max_tokens: v ?? 8192 })} /></Form.Item>
            </Space>
          )
        }]} />
        <Space wrap>
          <Button type="primary" loading={saving} data-testid="ai-save" onClick={() => save()}>保存</Button>
          <Button loading={testing === 'text'} data-testid="ai-test" onClick={() => test('text')}>测试连接</Button>
          <Button loading={testing === 'vision'} data-testid="ai-test-vision" disabled={!cfg.vision_model.trim()} onClick={() => test('vision')}>测试视觉模型</Button>
        </Space>
        {result && (
          <Alert data-testid="ai-test-result" style={{ marginTop: 12 }} type={result.ok ? 'success' : 'error'} showIcon
            message={`${result.kind === 'vision' ? '视觉模型' : '文本模型'}：${result.ok ? '成功' : '失败'}`} description={result.message} />
        )}
      </Form>
      <div style={{ fontSize: 12, color: '#999', marginTop: 12 }}>
        模型名称以服务商控制台为准，会随服务商更新。注意：DeepSeek 已在 2026 年 7 月下线 deepseek-chat，请不要再使用。
      </div>
      {usage.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b style={{ fontSize: 13 }}>累计 token 用量</b>
          <Table size="small" pagination={false} rowKey="model" dataSource={usage} style={{ marginTop: 6 }} columns={[
            { title: '模型', dataIndex: 'model' },
            { title: '调用次数', dataIndex: 'calls', width: 90 },
            { title: '输入', dataIndex: 'prompt', width: 100, render: (v: number) => v.toLocaleString() },
            { title: <Tooltip title="命中服务商前缀缓存的输入，通常更便宜">其中缓存命中</Tooltip>, dataIndex: 'cached', width: 120, render: (v: number) => v.toLocaleString() },
            { title: '输出', dataIndex: 'completion', width: 100, render: (v: number) => v.toLocaleString() },
            { title: '失败', dataIndex: 'failed', width: 70, render: (v: number) => (v ? <Tag color="error">{v}</Tag> : '-') }
          ]} />
        </div>
      )}
    </Card>
  )
}
