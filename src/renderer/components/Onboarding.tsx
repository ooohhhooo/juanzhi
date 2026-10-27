import React, { useEffect, useState } from 'react'
import { App, Select } from 'antd'
import { Check } from 'lucide-react'
import { Btn, Icon, StatusLabel } from '../design'
import '../design/page-library.css'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useStatsFilter } from '../stats/StatsFilter'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** 本次运行里，打开应用时库是不是空的（模块级：在页面之间切换不丢）。不是空的 = 老用户升级上来的，不打扰，直接当作已经引导过 */
let startedEmpty: boolean | null = null
export const TEXTBOOKS = ['人教PEP', '外研版', '北师大版', '译林版', '沪教版', '科普版', '教科版']

/**
 * 首次启动的三步卡片：① 配置 AI（可以跳过）② 拖入第一批卷子 ③ 选择教材版本；另有「先加载示例数据试一试」。
 * 全部做完或点「不再显示」后写 settings.onboarding_done，之后不再出现。教材版本存进 settings.default_textbook：
 * AI 没从卷头读出教材、老师也没填时，用它作新试卷的默认教材（AI 读到了就以 AI 为准）。
 */
export default function Onboarding() {
  const { message } = App.useApp()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { set } = useStatsFilter()
  const [skippedAi, setSkippedAi] = useState(false)
  const [loading, setLoading] = useState(false)
  const { data: done, isLoading } = useQuery({ queryKey: ['settings', 'onboarding_done'], queryFn: () => window.api.settings.get('onboarding_done') })
  const { data: tb } = useQuery({ queryKey: ['settings', 'default_textbook'], queryFn: () => window.api.settings.get('default_textbook') })
  const { data: ai } = useQuery({ queryKey: ['aiConfig'], queryFn: () => window.api.ai.getConfig() })
  const { data: papers = [] } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const { data: sample } = useQuery({ queryKey: ['data', 'sample'], queryFn: () => window.api.data.sampleStatus() })
  const real = papers.filter(p => !p.is_sample)
  const papersLoaded = papers.length > 0 || qc.getQueryState(['papers'])?.status === 'success'
  useEffect(() => {
    if (isLoading || done === true || !papersLoaded || startedEmpty !== null) return
    startedEmpty = real.length === 0
    if (!startedEmpty) window.api.settings.set('onboarding_done', true).then(() => qc.invalidateQueries({ queryKey: ['settings', 'onboarding_done'] })).catch(() => undefined)
  }, [isLoading, done, papersLoaded, real.length])
  if (isLoading || done === true || (startedEmpty === false)) return null

  const aiOk = !!ai?.hasKey && !!ai?.base_url && !!ai?.model
  const textbook = typeof tb === 'string' && tb ? tb : null
  const finish = async () => { await window.api.settings.set('onboarding_done', true); qc.invalidateQueries({ queryKey: ['settings', 'onboarding_done'] }) }
  const pickFiles = async () => {
    const paths = await window.api.dialog.openFiles()
    if (!paths.length) return
    try {
      await window.api.papers.import(paths)
      qc.invalidateQueries({ queryKey: ['papers'] })
    } catch (e) { message.error(clean(e)) }
  }
  const setTextbook = async (v: string | undefined) => {
    await window.api.settings.set('default_textbook', v ?? null)
    qc.invalidateQueries({ queryKey: ['settings', 'default_textbook'] })
  }
  const loadSample = async () => {
    setLoading(true)
    try {
      const r = await window.api.data.loadSample()
      qc.setQueryData(['data', 'sample'], { loaded: true, papers: r.papers, questions: r.questions })   // 先更新缓存，再切筛选：看板那边据此判断"还有没有示例数据"
      set({ sample: true })   // 看板切到示例数据，加载完立刻有内容；真实数据的统计不受影响
      qc.invalidateQueries({ queryKey: ['data'] }); qc.invalidateQueries({ queryKey: ['papers'] })
      message.success('示例数据已加载，看板里切到了「示例数据」')
      nav('/overview')
    } catch (e) { message.error(clean(e)) } finally { setLoading(false) }
  }

  // 一个面板里一列步骤：序号是真正的先后顺序，做完的步骤打勾
  const step = (n: number, title: string, ok: boolean, tag: React.ReactNode, body: React.ReactNode, testid: string) => (
    <li className="ewb-lib-step" data-testid={testid} data-done={ok ? '1' : '0'}>
      <span className="ewb-lib-stepn" aria-hidden>{ok ? <Icon as={Check} size={15} /> : n}</span>
      <div style={{ minWidth: 0 }}>
        <h3 className="ewb-lib-step__title">{title}{tag}</h3>
        {body}
      </div>
      <span />
    </li>
  )
  return (
    <section className="ewb-lib-guide" data-testid="onboarding" aria-label="开始使用">
      <div className="ewb-lib-guide__head">
        <h2 className="ewb-lib-guide__title">开始使用：三步就能出第一份分析</h2>
        <div className="ewb-lib-guide__tools"><Btn tone="quiet" size="small" data-testid="onb-done" onClick={finish}>不再显示</Btn></div>
      </div>
      <ol className="ewb-lib-steps">
        {step(1, '配置 AI 服务', aiOk, aiOk ? <StatusLabel kind="done">已配置</StatusLabel> : skippedAi ? <StatusLabel kind="queued">已跳过</StatusLabel> : <StatusLabel kind="queued">可跳过</StatusLabel>,
          <div className="ewb-lib-step__body">
            <p className="ewb-lib-step__text" style={{ margin: 0 }}>AI 负责把试卷拆成题并标上知识点。这一步一般由管理员做一次；不配置也能用——只是题目要手动标注。</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn tone="secondary" size="small" data-testid="onb-ai" onClick={() => nav('/settings?admin=1')}>去管理员设置</Btn>
              {!aiOk && !skippedAi && <Btn tone="quiet" size="small" data-testid="onb-skip-ai" onClick={() => setSkippedAi(true)}>先跳过</Btn>}
            </div>
          </div>, 'onb-step-ai')}
        {step(2, '拖入第一批卷子', real.length > 0, real.length > 0 ? <StatusLabel kind="done">已导入 {real.length} 份</StatusLabel> : <StatusLabel kind="pending">待完成</StatusLabel>,
          <div className="ewb-lib-step__body">
            <p className="ewb-lib-step__text" style={{ margin: 0 }}>把 PDF、图片或 Word 试卷拖到下面的虚线框里，或者点按钮选择文件。</p>
            <Btn tone="secondary" size="small" data-testid="onb-import" onClick={pickFiles}>选择文件</Btn>
          </div>, 'onb-step-papers')}
        {step(3, '选择教材版本', !!textbook, textbook ? <StatusLabel kind="done">{textbook}</StatusLabel> : <StatusLabel kind="pending">待完成</StatusLabel>,
          <div className="ewb-lib-step__body" style={{ width: '100%', maxWidth: 360 }}>
            <p className="ewb-lib-step__text" style={{ margin: 0 }}>卷头没写教材时，用它作新试卷的默认教材（之后可以在每份试卷里改）。</p>
            <Select data-testid="onb-textbook" allowClear placeholder="选择教材版本" value={textbook ?? undefined} style={{ width: '100%' }} onChange={v => setTextbook(v)}
              options={TEXTBOOKS.map(t => ({ value: t, label: t }))} />
            <span className="ewb-lib-step__hint">没有你的教材？在每份试卷的信息里手动填写即可。</span>
          </div>, 'onb-step-textbook')}
      </ol>
      <div className="ewb-lib-guide__foot">
        <span>想先看看效果？</span>
        <Btn tone="quiet" size="small" data-testid="onb-load-sample" loading={loading} onClick={loadSample}>{sample?.loaded ? '示例数据已加载，去看看' : '加载示例数据试一试'}</Btn>
        <span className="ewb-lib-sub">（内置的合成演示卷，不会混进你的真实数据，随时可在「设置 → 示例数据」一键清除）</span>
      </div>
    </section>
  )
}
