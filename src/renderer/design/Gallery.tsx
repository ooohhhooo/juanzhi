/**
 * 设计样板页 /design（隐藏路由，不在导航里）。
 * 用真实形态的数据展示每个组件的各种状态，浅色 / 深色各一套；第二阶段把新设计铺到各页面时照这里抄。
 * 数据说明：词条内容和原卷截图来自 samples/g4-2025-page1.png（四年级 2024–2025 期末卷）；
 * 「考过几份」「约几分」是示意数字，不是统计结果。
 */
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfigProvider, Drawer, Dropdown, Input, Modal, Segmented, Select, Switch, Tabs, Tag, Checkbox, message } from 'antd'
import { Download, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import {
  BarList, HeatCell, ReaderTag, Btn, Cloth, Contents, NAV_FOOTER, NAV_ITEMS, EmptyState, Entry, EntryColumns, EntrySkeleton, GuideWords, Glossary, Headline, IndexTable, PageTurn,
  PaperSheet, Panel, SectionTitle, StatusLabel, ThemeSwitch, ThinkingBar, ThumbIndex, UsageNote, useTheme
} from './index'
import { antdTheme, CATEGORIES, palettes, fontSizes, type CategoryKey, type Mode } from './tokens'
import q07 from './assets/gallery-q07.png?inline'
import q16 from './assets/gallery-q16.png?inline'
import { BY_CATEGORY, COUNTS, E_ABBR, E_EA, E_OPPOSITE, E_PLURAL, E_TIME, P25 } from './sampleData'

const PAPERS = [
  { id: 'a', title: '2024–2025 学年第二学期四年级英语期末试卷', grade: '四年级', year: '2024–2025', questions: 25, status: 'done' },
  { id: 'b', title: '2025–2026 学年第一学期四年级英语期末试卷', grade: '四年级', year: '2025–2026', questions: 28, status: 'reviewing' },
  { id: 'c', title: '三年级英语期中练习（扫描件）', grade: '三年级', year: '2025–2026', questions: 0, status: 'parsing' },
  { id: 'd', title: '五年级英语单元测试 Unit 3', grade: '五年级', year: '2025–2026', questions: 0, status: 'failed' }
]

// ───────────── 单个主题下的全部样本 ─────────────

function Specimens({ mode }: { mode: Mode }) {
  const [cat, setCat] = useState<CategoryKey>('grammar')
  const [catOrder, setCatOrder] = useState(2)
  const [modal, setModal] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [nav, setNav] = useState('/overview')
  const [msg, msgCtx] = message.useMessage()
  const p = palettes[mode]
  return (
    <div style={{ padding: '24px 32px 48px', maxWidth: 1240, margin: '0 auto' }}>
      {/* 1. 首屏样板：书眉 + 大字结论 + 两栏词条 + 书口索引 + 主按钮 */}
      <SectionTitle level={3} aside="总览首屏的做法">总览首屏</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 82px', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GuideWords scope="四年级 · 2024–2026 学年" first="ea 字母组合发音" last="问价格与购物" />
            </div>
            <Btn tone="primary" icon={Upload}>导入试卷</Btn>
          </div>
          <Headline><span>今年四年级 </span><Headline.Num>72</Headline.Num><span> 道题，最该补的是 </span><Headline.Term>名词复数</Headline.Term><span> 和 </span><Headline.Term>time for / to</Headline.Term></Headline>
          <PageTurn pageKey={cat} order={catOrder}>
            <EntryColumns always>
              {BY_CATEGORY[cat].map(e => <Entry key={e.term} {...e} size="standard" onOpen={() => setDrawer(true)} />)}
            </EntryColumns>
          </PageTurn>
        </div>
        <ThumbIndex counts={COUNTS} value={cat} onChange={k => { setCat(k); setCatOrder(CATEGORIES.findIndex(c => c.key === k)) }} />
      </div>

      {/* 2. 词条三种尺寸 */}
      <SectionTitle level={3} aside="紧凑（列表）· 标准（总览）· 完整（详情抽屉）">词条 Entry</SectionTitle>
      <Panel title="紧凑" bodyStyle={{ paddingTop: 0, paddingBottom: 0 }}>
        {[E_PLURAL, E_TIME, E_EA, E_OPPOSITE].map(e => <Entry key={e.term} {...e} size="compact" aside={<span className="ewb-num">{e.tags?.[0].label}</span>} />)}
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="完整（带用法框）">
        <Entry {...E_TIME} size="full" headingLevel={4}>
          <UsageNote kind="contrast" title="time for / time to 怎么选">
            <p style={{ margin: '0 0 4px' }}><b>time for</b> + 名词：It's time <b>for</b> lunch.（该吃午饭了）</p>
            <p style={{ margin: 0 }}><b>time to</b> + 动词原形：It's time <b>to</b> go home.（该回家了）</p>
          </UsageNote>
        </Entry>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="加载中（骨架）"><EntrySkeleton count={2} /></Panel>

      {/* 3. 用法框 */}
      <SectionTitle level={3} aside="易错红 / 辨析 / 注意 / 提示">用法框 UsageNote</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <UsageNote kind="mistake" title="tomato 的复数是 tomatoes">以 o 结尾的名词，有的加 es（tomato、potato），有的只加 s（photo、piano）。16 题里有 2 道错在这里。</UsageNote>
        <UsageNote kind="contrast" title="for 还是 to？">for 后面接名词，to 后面接动词。看空格后面的词是名词还是动词，就能选对。</UsageNote>
        <UsageNote kind="caution">只参考了 2 份试卷，这里看到的规律可能只是巧合，先不要当趋势。</UsageNote>
        <UsageNote kind="tip">点词条的名字可以打开详情，看到全部原卷例题。</UsageNote>
        <UsageNote kind="mistake" title="AI 没有解析成功" actions={<Btn tone="secondary" icon={RefreshCw} size="small">重试</Btn>}>
          这份卷子的文字太模糊，AI 没认出题目。确认图片清晰后点「重试」；还不行就换一张更清楚的扫描件。
        </UsageNote>
      </div>

      {/* 4. 术语释义 */}
      <SectionTitle level={3} aside="悬停或键盘聚焦查看释义">术语 Glossary</SectionTitle>
      <p style={{ maxWidth: 640, margin: 0 }}>
        每个知识点的 <Glossary term="分值占比" />、<Glossary term="出现率" /> 和 <Glossary term="同比" /> 都有一句白话解释；
        样本太少时标出 <Glossary term="样本不足" />，提醒读者别把偶然当规律。
      </p>

      {/* 5. 状态 */}
      <SectionTitle level={3} aside="处理队列、试卷库用">状态标签与 AI 思考条</SectionTitle>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <StatusLabel status="imported" /><StatusLabel status="parsing" /><StatusLabel status="reviewing" /><StatusLabel status="done" /><StatusLabel status="failed" />
      </div>
      <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
        <ThinkingBar elapsedSeconds={48} />
        <ThinkingBar elapsedSeconds={205} label="AI 正在写报告" onCancel={() => undefined} />
      </div>

      {/* 6. 按钮与表单控件 */}
      <SectionTitle level={3} aside="每页只放一个主按钮">按钮与控件</SectionTitle>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <Btn tone="primary" icon={Plus}>导入试卷</Btn>
        <Btn tone="secondary" icon={Download}>导出 PDF</Btn>
        <Btn tone="danger" icon={Trash2}>清除示例数据</Btn>
        <Btn tone="quiet">查看详情</Btn>
        <Btn tone="primary" loading>生成中</Btn>
        <Btn tone="primary" disabled>不可用</Btn>
        <Btn tone="secondary" disabled>不可用</Btn>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <Input placeholder="搜索考点，如「复数」" style={{ width: 220 }} />
        <Input status="error" defaultValue="2024-25" style={{ width: 160 }} />
        <Select placeholder="年级" style={{ width: 120 }} options={['三年级', '四年级', '五年级'].map(v => ({ value: v, label: v }))} />
        <Segmented options={['分布', '同比', '重难点']} defaultValue="分布" />
        <Switch defaultChecked /> <span>含待审核</span>
        <Checkbox defaultChecked>包含重复导入</Checkbox>
        <Tag>四年级</Tag><Tag>期末</Tag>
      </div>
      <Tabs items={[{ key: 'a', label: '分布', children: null }, { key: 'b', label: '同比', children: null }, { key: 'c', label: '重难点', children: null }]} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Btn tone="secondary" onClick={() => setModal(true)}>打开对话框</Btn>
        <Btn tone="secondary" onClick={() => setDrawer(true)}>打开词条抽屉</Btn>
        <Btn tone="secondary" onClick={() => msg.success('已加入处理队列：1 份')}>显示提示</Btn>
        <Dropdown menu={{ items: [{ key: 'a', label: '重试 AI 解析' }, { key: 'b', label: '从头重试（重新提取）' }] }}><span><Btn tone="secondary">更多操作</Btn></span></Dropdown>
        {msgCtx}
      </div>

      {/* 7. 表格 */}
      <SectionTitle level={3} aside="细线分隔、标题列加粗、等宽数字、操作带文字">表格：词典索引页</SectionTitle>
      <IndexTable
        rowKey="id"
        dataSource={PAPERS}
        columns={[
          { title: '试卷', dataIndex: 'title', width: '42%' },
          { title: '年级', dataIndex: 'grade' },
          { title: '学年', dataIndex: 'year', render: v => <span className="ewb-num">{v}</span> },
          { title: '题数', dataIndex: 'questions', align: 'right', render: v => <span className="ewb-num">{v || '—'}</span> },
          { title: '状态', dataIndex: 'status', render: v => <StatusLabel status={v} /> },
          { title: '操作', key: 'op', render: (_, r) => (r.status === 'failed' ? <Btn tone="quiet" icon={RefreshCw} size="small">重试</Btn> : <Btn tone="quiet" size="small">查看</Btn>) }
        ]}
      />

      {/* 7b. 横条图、热力格、读者标签 */}
      <SectionTitle level={3} aside="条形用对应大类的颜色；旁边永远写数字">横条图、热力格、读者标签</SectionTitle>
      <Panel>
        <BarList rows={[
          { label: '名词复数', value: 1, note: '2/2 份 · 100%', category: 'grammar' },
          { label: 'time for / time to', value: 1, note: '2/2 份 · 100%', category: 'grammar' },
          { label: '购物用语', value: 1, note: '2/2 份 · 100%', category: 'communication' },
          { label: '连词成句', value: 1, note: '2/2 份 · 100%', category: 'writing' },
          { label: '反义词', value: 0.5, note: '1/2 份 · 50%', category: 'vocab' },
          { label: 'ea 字母组合发音', value: 0.5, note: '1/2 份 · 50%', category: 'phonics' }
        ]} />
        <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--ewb-ink-2)' }}>热力格：</span>
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map(r => <HeatCell key={r} rate={r}>{Math.round(r * 10)}</HeatCell>)}
          <span style={{ marginLeft: 16, color: 'var(--ewb-ink-2)' }}>读者：</span>
          <ReaderTag reader="boss" /><ReaderTag reader="parent" /><ReaderTag reader="teacher" /><ReaderTag reader="full" />
        </div>
      </Panel>

      {/* 8. 空状态 */}
      <SectionTitle level={3} aside="要教会这个界面怎么用">空状态</SectionTitle>
      <Panel>
        <EmptyState inline title="还没有导入试卷" description="导入后，每个考点会变成一个词条，附上原卷里的例题。"
          steps={['把试卷（PDF、照片或 Word）拖进窗口，或点「导入试卷」', '等 AI 解析完（每份约 2–3 分钟），到「审核」里确认题目', '回到「总览」，就能查到今年最该关注的词条']}
          action={<Btn tone="primary" icon={Upload}>导入试卷</Btn>} />
      </Panel>

      {/* 9. 原卷纸 + 布面 */}
      <SectionTitle level={3} aside="深色模式下原卷仍是白纸">原卷纸与布面</SectionTitle>
      <Cloth>
        <div style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
          <PaperSheet><img src={q07} alt="第 7 题" /></PaperSheet>
          <PaperSheet><img src={q16} alt="第 16–20 题" /></PaperSheet>
        </div>
      </Cloth>

      {/* 10. 侧栏 */}
      <SectionTitle level={3} aside="窄图标栏：图标 + 两字标签，当前项白色底">侧栏 Contents</SectionTitle>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ width: 84, height: 640, background: p.paper, borderRadius: 24 }}>
          <Contents items={NAV_ITEMS(2, 3)} footerItems={NAV_FOOTER} activeKey={nav} onNavigate={setNav} />
        </div>
      </div>

      {/* 11. 色板与字号 */}
      <SectionTitle level={3} aside="全部来自 tokens.ts">颜色与字号</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0 32px' }}>
        {([['应用底色', p.paper], ['画布', p.page], ['正文墨', p.ink], ['次要', p.ink2], ['主色（长春花紫）', p.primary], ['易错（玫红）', p.red], ['信息框', p.note], ['细线', p.line]] as const).map(([n, v]) => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: `1px solid ${p.line}` }}>
            <span style={{ width: 28, height: 28, borderRadius: 4, background: v, border: `1px solid ${p.lineStrong}` }} />
            <span style={{ flex: 1 }}>{n}</span><span className="ewb-num" style={{ color: p.ink2 }}>{v}</span>
          </div>
        ))}
        {CATEGORIES.map(c => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: `1px solid ${p.line}` }}>
            <span style={{ width: 28, height: 28, borderRadius: 4, background: c[mode] }} />
            <span style={{ flex: 1 }}>{c.label}（{c.gloss.slice(0, 10)}…）</span><span className="ewb-num" style={{ color: p.ink2 }}>{c[mode]}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 4 }}>
        {Object.entries(fontSizes).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span className="ewb-num" style={{ width: 48, color: p.ink2 }}>{v}px</span>
            <span style={{ fontSize: v, fontWeight: v >= 22 ? 700 : 400, lineHeight: 1.3 }}>名词复数 <i lang="en">books · boxes · /ˈbʊks/</i> 0123456789</span>
          </div>
        ))}
      </div>

      <Modal open={modal} title="清除全部示例数据？" onCancel={() => setModal(false)} onOk={() => setModal(false)} okText="清除" cancelText="取消" okButtonProps={{ danger: true }}>
        示例卷、它们的页面图，以及基于示例数据生成的报告都会删除；你的真实数据不受影响。
      </Modal>
      <Drawer open={drawer} onClose={() => setDrawer(false)} size={560} title="词条详情">
        <Entry {...E_PLURAL} size="full" headingLevel={2}>
          <UsageNote kind="mistake" title="tomato 的复数是 tomatoes">以 o 结尾的名词，有的加 es（tomato、potato），有的只加 s（photo、piano）。</UsageNote>
        </Entry>
      </Drawer>
    </div>
  )
}

// ───────────── 页面 ─────────────

type View = 'current' | 'light' | 'dark' | 'both'

function Scope({ mode, children }: { mode: Mode; children: React.ReactNode }) {
  const p = palettes[mode]
  return (
    <div data-theme-scope={mode} data-testid={`gallery-${mode}`} style={{ background: p.paper, color: p.ink, borderTop: `1px solid ${p.line}`, colorScheme: mode }}>
      <ConfigProvider theme={antdTheme(mode)}>{children}</ConfigProvider>
    </div>
  )
}

export default function Gallery() {
  const { mode } = useTheme()
  const nav = useNavigate()
  const [view, setView] = useState<View>('current')
  return (
    <div data-testid="gallery">
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 32px 0' }}>
        <h1 style={{ margin: 0, fontSize: fontSizes.h2, fontWeight: 700 }}>设计样板：英语学习词典 <Btn tone="secondary" size="small" onClick={() => nav('/design/overview?admin=1')} style={{ verticalAlign: 'middle', marginLeft: 12 }}>看总览样张</Btn></h1>
        <p style={{ margin: '4px 0 16px', color: 'var(--ewb-ink-2)' }}>每个组件的真实形态与各种状态。数字是示意，截图来自 samples 里的四年级期末卷。</p>
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: fontSizes.sm, color: 'var(--ewb-ink-2)', marginBottom: 4 }}>显示</div>
            <Segmented value={view} onChange={v => setView(v as View)} options={[{ label: '当前主题', value: 'current' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }, { label: '浅色 + 深色', value: 'both' }]} />
          </div>
          <div style={{ width: 240 }}><ThemeSwitch /></div>
        </div>
      </div>
      {view === 'current' && <Specimens mode={mode} />}
      {view === 'light' && <Scope mode="light"><Specimens mode="light" /></Scope>}
      {view === 'dark' && <Scope mode="dark"><Specimens mode="dark" /></Scope>}
      {view === 'both' && (<><Scope mode="light"><Specimens mode="light" /></Scope><Scope mode="dark"><Specimens mode="dark" /></Scope></>)}
    </div>
  )
}
