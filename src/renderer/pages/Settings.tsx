import React, { useEffect, useState } from 'react'
import { App, Descriptions, Select, Switch } from 'antd'
import { BookOpen, CircleHelp, ScanSearch, Settings as SettingsIcon, Monitor, Plug, Info, Cpu, Database, MessageSquareText, Terminal, ShieldCheck, ListTree, type LucideIcon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AiSettings from './AiSettings'
import PromptSettings from './PromptSettings'
import DataSettings from './DataSettings'
import CliSettings from './CliSettings'
import ConnectorSettings from './ConnectorSettings'
import UpdateSettings from './UpdateSettings'
import TaxonomySettings from './TaxonomySettings'
import DiagnosticsPanel from '../components/DiagnosticsPanel'
import { useAdminOpen, useShowCodes } from '../hooks/useUiPrefs'
import { Btn, Glossary, Page, Panel, StatusLabel, UsageNote, useTheme } from '../design'
import '../design/page-report.css'

type TabId = 'show' | 'kp' | 'connectors' | 'about' | 'admin' | 'ai' | 'data' | 'prompts' | 'cli'
interface TabDef { id: TabId; label: string; desc: string; icon: LucideIcon; admin?: boolean }
const GROUPS: Array<{ label: string; tabs: TabDef[] }> = [
  { label: '常用', tabs: [
    { id: 'show', label: '显示与演示', desc: '界面大小、示例数据、打开软件先进哪一页。', icon: Monitor },
    { id: 'kp', label: '知识点', desc: 'AI 标题目、看板统计都按这棵树来；可以改名，加白话说明和例句。', icon: ListTree },
    { id: 'connectors', label: '连接器', desc: '连接企业微信、飞书等外部工具，助手就能把结果发出去或读取那边的资料。', icon: Plug },
    { id: 'about', label: '关于与更新', desc: '版本、软件更新、使用说明，以及重新检查重复试卷。', icon: Info }
  ] },
  { label: '管理员', tabs: [
    { id: 'admin', label: '管理员设置', desc: '技术设置默认收起。改错了可能让 AI 解析失败，不确定请联系管理员。', icon: ShieldCheck },
    { id: 'ai', label: 'AI 服务与识别', desc: '连接 AI 服务、输出长度、并发，以及文字识别。', icon: Cpu, admin: true },
    { id: 'data', label: '数据存储', desc: '数据位置、备份和换电脑用的数据包。', icon: Database, admin: true },
    { id: 'prompts', label: '提示词', desc: 'AI 的写作要求。', icon: MessageSquareText, admin: true },
    { id: 'cli', label: '命令行', desc: '给其他程序调用卷知的命令行工具。', icon: Terminal, admin: true }
  ] }
]
const ALL_TABS = GROUPS.flatMap(g => g.tabs)

/**
 * 设置页：左侧导航 + 右侧只显示选中的一项。当前项记在网址里：#/settings?tab=ai。
 * 旧链接仍有效：?admin=1 → 展开管理员设置并进「AI 服务与识别」；?focus=about → 关于与更新（菜单「检查更新…」）。
 */
export default function Settings() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [adminOpen, setAdminOpen] = useAdminOpen()
  const [showCodes, setShowCodes] = useShowCodes()
  const { bigText, setBigText } = useTheme()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const finishScan = (checked: number, suspects: number | null) => {
    setScanning(false); setScanProgress(null)
    if (suspects != null) setScanResult(`检查了 ${checked} 份，有 ${suspects} 份疑似重复`)
    qc.invalidateQueries({ queryKey: ['papers'] }); qc.invalidateQueries({ queryKey: ['stats'] })
  }
  // 整库重新检查疑似重复：后台扫描，期间按钮显示「检查中」。刷新页面后用 scanSimilarStatus 恢复状态；升级后的那次自动扫描也会走这些事件
  useEffect(() => {
    let alive = true
    window.api.papers.scanSimilarStatus().then(st => { if (alive && st.running) { setScanning(true); setScanProgress({ done: st.done, total: st.total }) } }, () => undefined)
    const off = window.api.on?.('similar:progress', (p: { running: boolean; done: number; total: number; suspects: number | null }) => {
      if (!alive) return
      if (p.running) { setScanning(true); setScanProgress({ done: p.done, total: p.total }) } else finishScan(p.total, p.suspects)
    })
    return () => { alive = false; off?.() }
  }, [])
  const scanSimilar = async () => {
    setScanning(true)
    try {
      const r = await window.api.papers.scanSimilar()   // 扫描完成才 resolve；重复点击拿到的是同一个 Promise
      const t = `检查了 ${r.checked} 份，有 ${r.suspects} 份疑似重复`
      setScanResult(t); message.success(t)
      setScanning(false); setScanProgress(null)
      qc.invalidateQueries({ queryKey: ['papers'] }); qc.invalidateQueries({ queryKey: ['stats'] })
    } catch (e) { setScanning(false); setScanProgress(null); message.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const { data: ocr, refetch: recheckOcr, isFetching: checkingOcr } = useQuery({
    queryKey: ['ocr', 'status'],
    queryFn: () => window.api.ocr.status(),
    staleTime: 0,
    enabled: adminOpen
  })
  const { data: startPage = null } = useQuery({ queryKey: ['settings', 'start_page'], queryFn: () => window.api.settings.get('start_page') as Promise<string | null>, staleTime: 0 })
  const { data: about } = useQuery({ queryKey: ['app', 'info'], queryFn: () => window.api.app.info(), staleTime: Infinity })
  const [, setParams] = useSearchParams()
  useEffect(() => { if (params.get('admin') === '1' && !adminOpen) void setAdminOpen(true) }, [params, adminOpen])
  const rawTab = params.get('tab') ?? (params.get('focus') === 'about' ? 'about' : params.get('admin') === '1' ? 'ai' : 'show')
  const def0 = ALL_TABS.find(t => t.id === rawTab) ?? ALL_TABS[0]
  const adminWanted = params.get('admin') === '1' || adminOpen
  const cur = def0.admin && !adminWanted ? ALL_TABS.find(t => t.id === 'admin')! : def0
  const go = (id: TabId) => setParams({ tab: id }, { replace: true })

  const note = (t: string) => <p className="ewb-rep-note" style={{ marginTop: 6 }}>{t}</p>
  const body = (() => {
    switch (cur.id) {
      case 'show': return <>
        <div className="ewb-set-panel">
          <Panel title="显示" data-testid="display-common">
            <div className="ewb-rep-row" style={{ gap: 8 }}>
              <label className="ewb-rep-switchlabel"><Switch data-testid="big-text-switch" checked={bigText} onChange={v => setBigText(v)} /> <span data-testid="big-text-label">投屏大字</span></label>
            </div>
            {note('投屏讲解时打开，整个界面放大到 115%。只记在这台电脑上。')}
          </Panel>
        </div>
        <div className="ewb-set-panel">
          <Panel title="启动页">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="打开卷知时先进入">
                <Select size="small" style={{ width: 140 }} data-testid="start-page" value={startPage === 'assistant' ? 'assistant' : 'library'}
                  options={[{ value: 'library', label: '试卷库' }, { value: 'assistant', label: '助手' }]}
                  onChange={async v => { await window.api.settings.set('start_page', v); qc.invalidateQueries({ queryKey: ['settings', 'start_page'] }); message.success('下次打开卷知时生效') }} />
              </Descriptions.Item>
            </Descriptions>
          </Panel>
        </div>
        <DataSettings part="common" />
      </>
      case 'kp': return <TaxonomySettings />
      case 'connectors': return <ConnectorSettings />
      case 'about': return (
        <div className="ewb-set-panel">
          <Panel title="关于" data-testid="about-card">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="软件">卷知 · 小学试卷分析（离线桌面软件，数据只存在这台电脑上）</Descriptions.Item>
              <Descriptions.Item label="版本"><span data-testid="about-version">{about?.version ?? '…'}</span>（数据库版本 v{about?.schema ?? '…'}）<span className="ewb-lib-tag" style={{ marginLeft: 8 }} data-testid="about-beta">公测版</span></Descriptions.Item>
              <Descriptions.Item label="遇到问题"><DiagnosticsPanel /></Descriptions.Item>
              <Descriptions.Item label="软件更新"><UpdateSettings /></Descriptions.Item>
              {adminOpen && <Descriptions.Item label="运行环境"><span data-testid="about-env">{about ? `${about.platform} ${about.arch} · Electron ${about.electron} · Chromium ${about.chrome} · Node ${about.node}` : '…'}</span></Descriptions.Item>}
              {adminOpen && <Descriptions.Item label="数据目录"><code className="ewb-rep-code">{about?.dataDir}</code></Descriptions.Item>}
              <Descriptions.Item label="检查重复试卷">
                <span className="ewb-rep-row" style={{ gap: 8 }}>
                  <Btn tone="secondary" size="small" icon={ScanSearch} loading={scanning} data-testid="scan-similar" onClick={scanSimilar}>{scanning ? '检查中' : '检查重复试卷'}</Btn>
                  {scanning && scanProgress && scanProgress.total > 0 && <span data-testid="scan-similar-progress">{scanProgress.done}/{scanProgress.total} 份</span>}
                  {scanResult && <span data-testid="scan-similar-result">{scanResult}</span>}
                </span>
                {note('把库里所有试卷重新比一遍。被标出来的默认不计入统计，可到试卷库里处理。')}
              </Descriptions.Item>
              <Descriptions.Item label="使用说明">
                <Btn tone="quiet" size="small" icon={CircleHelp} data-testid="open-help-settings" onClick={() => nav('/help')}>查看使用说明（运营 / 辅导老师）</Btn>
              </Descriptions.Item>
              <Descriptions.Item label="安装指南">
                <Btn tone="quiet" size="small" icon={BookOpen} data-testid="open-guide" onClick={() => nav('/guide')}>查看安装指南</Btn>
              </Descriptions.Item>
            </Descriptions>
          </Panel>
        </div>
      )
      case 'admin': return <>
        <div className="ewb-set-panel">
          <Panel title="技术设置" data-testid="admin-settings" aside={<Btn tone={adminOpen ? 'secondary' : 'primary'} size="small" icon={SettingsIcon} data-testid="admin-toggle" onClick={() => setAdminOpen(!adminOpen)}>{adminOpen ? '收起' : '展开管理员设置'}</Btn>}>
            <p className="ewb-rep-note">AI 服务、文字识别、提示词、数据位置和备份。展开后左侧会出现对应的几项。</p>
          </Panel>
        </div>
        {adminOpen && (
          <div data-testid="admin-settings-body">
            <UsageNote kind="caution" title="这些是技术设置">改错了可能让 AI 解析失败或结果变差。不确定时先不要动。</UsageNote>
            <div className="ewb-set-panel" style={{ marginTop: 'var(--ewb-sp-3)' }}>
              <Panel title="显示选项" data-testid="display-options">
                <div className="ewb-rep-row" style={{ gap: 8 }}>
                  <label className="ewb-rep-switchlabel"><Switch data-testid="show-codes-switch" checked={showCodes} onChange={v => setShowCodes(v)} /> <span><Glossary term="内部代码">显示内部代码</Glossary></span></label>
                </div>
                {note('知识点和题型后面的英文编号默认不显示，排查问题时可以打开。')}
              </Panel>
            </div>
          </div>
        )}
      </>
      case 'ai': return <>
        <AiSettings />
        <div className="ewb-set-panel">
          <Panel title="文字识别（OCR）">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="状态">
                <span className="ewb-rep-row" style={{ gap: 8 }}>
                  {ocr
                    ? <span data-testid="ocr-status"><StatusLabel kind={ocr.available ? 'done' : 'failed'}>{ocr.available ? '可用' : '不可用'}</StatusLabel></span>
                    : '检测中…'}
                  {ocr && <span data-testid="ocr-detail">{ocr.detail}</span>}
                  <Btn tone="quiet" size="small" loading={checkingOcr} onClick={() => recheckOcr()}>重新检测</Btn>
                </span>
              </Descriptions.Item>
            </Descriptions>
            <p className="ewb-rep-note"><Glossary term="文字识别">文字识别</Glossary>（OCR）把卷子图片里的字读出来。</p>
          </Panel>
        </div>
      </>
      case 'data': return <DataSettings part="admin" />
      case 'prompts': return <PromptSettings />
      case 'cli': return <CliSettings />
    }
  })()

  return (
    <Page>
      <h1 className="ewb-rep-h1">设置</h1>
      <div className="ewb-set-layout">
        <nav className="ewb-set-nav" aria-label="设置分类" data-testid="settings-nav">
          {GROUPS.map(g => (
            <div key={g.label} className="ewb-set-navgroup">
              <div className="ewb-set-navlabel">{g.label}</div>
              {g.tabs.filter(t => !t.admin || adminOpen).map(t => (
                <button key={t.id} type="button" className="ewb-set-navitem" aria-current={t.id === cur.id ? 'page' : undefined} data-testid={`settings-nav-${t.id}`} onClick={() => go(t.id)}>
                  <t.icon size={16} aria-hidden />{t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="ewb-set-pane" key={cur.id}>
          <h2 className="ewb-set-group">{cur.label}</h2>
          <p className="ewb-set-groupdesc">{cur.desc}</p>
          {body}
        </div>
      </div>
    </Page>
  )
}
