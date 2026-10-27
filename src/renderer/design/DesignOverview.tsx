/**
 * 总览高保真样张（/design/overview）：完全按 docs/设计方向-学习词典.md 的 FIRST VIEWPORT 做。
 * 书眉式范围条（点开展开筛选）、大字结论（44px 数字嵌在句子里）、易错用法框、两栏词条（带原卷缩略）、右侧书口拇指索引、右上主按钮。
 * 数据：两份真实四年级期末卷的分析结果；截图是真实原卷截图；个别数字是示意（见页脚）。
 */
import React, { useState } from 'react'
import { Select, Switch } from 'antd'
import { Upload } from 'lucide-react'
import { Btn, Page, EntryColumns, SectionTitle } from './Basics'
import Entry from './Entry'
import Glossary from './Glossary'
import Headline from './Headline'
import ScopeBar, { ScopeField } from './ScopeBar'
import ThumbIndex, { PageTurn } from './ThumbIndex'
import UsageNote from './UsageNote'
import DesignShell from './DesignShell'
import { BY_CATEGORY, COUNTS, TOP_ENTRIES } from './sampleData'
import { CATEGORIES, CATEGORY_BY_KEY, type CategoryKey } from './tokens'

export default function DesignOverview() {
  const [cat, setCat] = useState<CategoryKey | null>(null)
  const [order, setOrder] = useState(0)
  const entries = cat ? BY_CATEGORY[cat] : TOP_ENTRIES
  const sel = (ph: string, opts: string[], v?: string, w = 120) => <Select placeholder={ph} defaultValue={v} style={{ width: w }} options={opts.map(o => ({ value: o, label: o }))} />
  return (
    <DesignShell>
      <Page>
        <ScopeBar
          scope="四年级 · 2024–2026 学年 · 期末"
          first={entries[0].term}
          last={entries[entries.length - 1].term}
          actions={<Btn tone="primary" icon={Upload}>导入试卷</Btn>}
        >
          <ScopeField label="年级">{sel('全部', ['三年级', '四年级', '五年级'], '四年级', 112)}</ScopeField>
          <ScopeField label="学期">{sel('全部', ['上学期', '下学期'], undefined, 112)}</ScopeField>
          <ScopeField label="学年">{sel('全部', ['2024–2025', '2025–2026'], undefined, 136)}</ScopeField>
          <ScopeField label="考试类型">{sel('全部', ['期末', '期中', '单元测试'], '期末', 128)}</ScopeField>
          <ScopeField label="教材">{sel('全部', ['人教 PEP'], undefined, 128)}</ScopeField>
          <ScopeField label="地区">{sel('全部', ['北京', '上海'], undefined, 112)}</ScopeField>
          <div className="ewb-scope__switches">
            <label><Switch size="small" /> 含待审核</label>
            <label><Switch size="small" /> 包含重复导入（会重复计数）</label>
          </div>
        </ScopeBar>

        <div className="ewb-ov-head">
          <div>
            <Headline>
              <span>这 2 份四年级期末卷共 </span><Headline.Num>72</Headline.Num><span> 道题，最该补的是 </span>
              <Headline.Term>名词复数</Headline.Term><span> 和 </span><Headline.Term>time for / to</Headline.Term>
            </Headline>
            <p className="ewb-ov-basis">
              依据 2024–2025、2025–2026 两份期末卷。只有 2 份卷子，属于 <Glossary term="样本不足" />，规律先当参考，不要当趋势。
            </p>
          </div>
          <UsageNote kind="mistake" title="最容易丢分：tomato 的复数是 tomatoes">
            以 o 结尾的名词，有的加 es（tomato、potato），有的只加 s（photo、piano）。<Glossary term="名词复数" />这一项，AI 估计有 6 道题学生容易做错。
          </UsageNote>
        </div>

        <div className="ewb-ov-body">
          <div>
            <SectionTitle level={3} compact aside={cat
              ? <>{CATEGORY_BY_KEY[cat].label} · {COUNTS[cat]} 个词条 <Btn tone="quiet" size="small" onClick={() => setCat(null)}>回到最该关注</Btn></>
              : '按 AI 估计的易错题数和分值排序'}>
              {cat ? `${CATEGORY_BY_KEY[cat].label}类词条` : '今年最该关注的词条'}
            </SectionTitle>
            <PageTurn pageKey={cat ?? 'top'} order={order}>
              <EntryColumns always>
                {entries.map(e => <Entry key={e.term} {...e} size="standard" onOpen={() => undefined} />)}
              </EntryColumns>
            </PageTurn>
          </div>
          <ThumbIndex counts={COUNTS} value={cat} onChange={k => { setCat(k); setOrder(CATEGORIES.findIndex(c => c.key === k)) }} />
        </div>
        <p className="ewb-ov-foot">样张：词条和数字取自两份四年级期末卷的分析结果；「物主代词」和各大类的词条数是示意。截图均为真实原卷。</p>
      </Page>
    </DesignShell>
  )
}
