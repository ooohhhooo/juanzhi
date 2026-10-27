import React, { useEffect, useState } from 'react'
import { App, Descriptions, Switch } from 'antd'
import { BookOpen, CircleHelp, ScanSearch, Settings as SettingsIcon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AiSettings from './AiSettings'
import PromptSettings from './PromptSettings'
import DataSettings from './DataSettings'
import TaxonomySettings from './TaxonomySettings'
import { useAdminOpen, useShowCodes } from '../hooks/useUiPrefs'
import { Btn, Glossary, Page, Panel, StatusLabel, UsageNote, useTheme } from '../design'
import '../design/page-report.css'

/**
 * 设置页分两组：
 *  · 常用：示例数据、知识点（改名、加白话和例句）、使用说明、关于；
 *  · 管理员设置（默认收起）：连接 AI 服务（Base URL、密钥、输出长度、并发）、文字识别、提示词、数据位置与数据包、「显示内部代码」。
 *    运营和老师平时不用打开；它们的位置在 /settings?admin=1（各处「请联系管理员」的提示直接链到这里）。
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
  const { data: about } = useQuery({ queryKey: ['app', 'info'], queryFn: () => window.api.app.info(), staleTime: Infinity })
  useEffect(() => { if (params.get('admin') === '1' && !adminOpen) void setAdminOpen(true) }, [params, adminOpen])

  return (
    <Page>
      <h1 className="ewb-rep-h1">设置</h1>
      <p className="ewb-set-lead">平时用到的就是下面前三组；技术设置都收在最后的「管理员设置」里，一般不用动。</p>
      <nav className="ewb-set-jump" aria-label="跳到">
        {[['show', '显示与演示'], ['kp', '知识点'], ['about', '关于'], ['admin', '管理员设置']].map(([id, label]) => (
          <button key={id} type="button" className="ewb-set-jump__btn" onClick={() => document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>
        ))}
      </nav>

      <section id="set-show" className="ewb-set-section">
        <h2 className="ewb-set-group">显示与演示</h2>
        <p className="ewb-set-groupdesc">界面大小，以及用内置的演示卷先试一试。</p>
        <div className="ewb-set-panel">
          <Panel title="显示" data-testid="display-common">
            <div className="ewb-rep-row" style={{ gap: 8 }}>
              <label className="ewb-rep-switchlabel"><Switch data-testid="big-text-switch" checked={bigText} onChange={v => setBigText(v)} /> <span data-testid="big-text-label">投屏大字</span></label>
            </div>
            <p className="ewb-rep-note" style={{ marginTop: 6 }}>给老板或家长投屏讲解时打开：整个界面放大到 115%，字更大更清楚。只记在这台电脑上，随时可以关掉。</p>
          </Panel>
        </div>
        <DataSettings part="common" />
      </section>

      <section id="set-kp" className="ewb-set-section">
        <h2 className="ewb-set-group">知识点</h2>
        <p className="ewb-set-groupdesc">AI 标题目、看板统计都按这棵树来；老师可以改名，加白话说明和例句。</p>
        <TaxonomySettings />
      </section>

      <section id="set-about" className="ewb-set-section">
        <h2 className="ewb-set-group">关于</h2>
        <p className="ewb-set-groupdesc">软件版本、使用说明，以及重新检查重复的试卷。</p>
      <div className="ewb-set-panel">
        <Panel title="关于" data-testid="about-card">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="软件">英语校考分析工作台 —— 帮助教师分析试卷中的知识点分布和考频趋势（离线桌面软件，数据只存在这台电脑上，没有服务器、不用登录）</Descriptions.Item>
            <Descriptions.Item label="版本"><span data-testid="about-version">{about?.version ?? '…'}</span>（数据库版本 v{about?.schema ?? '…'}）</Descriptions.Item>
            {adminOpen && <Descriptions.Item label="运行环境"><span data-testid="about-env">{about ? `${about.platform} ${about.arch} · Electron ${about.electron} · Chromium ${about.chrome} · Node ${about.node}` : '…'}</span></Descriptions.Item>}
            {adminOpen && <Descriptions.Item label="数据目录"><code className="ewb-rep-code">{about?.dataDir}</code></Descriptions.Item>}
            <Descriptions.Item label="检查重复试卷">
              <span className="ewb-rep-row" style={{ gap: 8 }}>
                <Btn tone="secondary" size="small" icon={ScanSearch} loading={scanning} data-testid="scan-similar" onClick={scanSimilar}>{scanning ? '检查中' : '检查重复试卷'}</Btn>
                {scanning && scanProgress && scanProgress.total > 0 && <span data-testid="scan-similar-progress">{scanProgress.done}/{scanProgress.total} 份</span>}
                {scanResult && <span data-testid="scan-similar-result">{scanResult}</span>}
              </span>
              <p className="ewb-rep-note" style={{ marginTop: 4 }}>把库里所有试卷重新比一遍，找出像是别的卷子一部分的。被标出来的默认不计入统计，可以到试卷库里选「确实是新卷」或删除。</p>
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

      </section>

      <section id="set-admin" className="ewb-set-section">
      <h2 className="ewb-set-group">管理员设置</h2>
      <p className="ewb-set-groupdesc">连接 AI 服务、文字识别、数据位置和备份。改错了可能让 AI 解析失败，不确定请联系管理员。</p>
      <div className="ewb-set-panel">
        <Panel title="技术设置" data-testid="admin-settings" aside={<Btn tone={adminOpen ? 'secondary' : 'primary'} size="small" icon={SettingsIcon} data-testid="admin-toggle" onClick={() => setAdminOpen(!adminOpen)}>{adminOpen ? '收起' : '展开管理员设置'}</Btn>}>
          <p className="ewb-rep-note">连接 AI 服务、文字识别、AI 的写作要求、数据位置和备份这类技术设置，一般不用改，请管理员处理。</p>
        </Panel>
      </div>

      {adminOpen && (
        <div data-testid="admin-settings-body">
          <UsageNote kind="caution" title="下面是技术设置">改错了可能让 AI 解析失败或结果变差。不确定时先不要动，或联系管理员。</UsageNote>
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
              <p className="ewb-rep-note"><Glossary term="文字识别">文字识别</Glossary>（OCR）把卷子图片里的字读出来，让电脑能处理。</p>
            </Panel>
          </div>
          <PromptSettings />
          <DataSettings part="admin" />
          <div className="ewb-set-panel">
            <Panel title="显示选项" data-testid="display-options">
              <div className="ewb-rep-row" style={{ gap: 8 }}>
                <label className="ewb-rep-switchlabel"><Switch data-testid="show-codes-switch" checked={showCodes} onChange={v => setShowCodes(v)} /> <span><Glossary term="内部代码">显示内部代码</Glossary></span></label>
              </div>
              <p className="ewb-rep-note" style={{ marginTop: 6 }}>知识点和题型后面的英文编号（如 GR.PRON.POSS、PH_DIFF）默认不显示，排查问题时可以打开。报告里的代码一直不显示。</p>
            </Panel>
          </div>
        </div>
      )}
      </section>
    </Page>
  )
}
