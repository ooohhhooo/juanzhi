import React, { useState } from 'react'
import { Tabs } from 'antd'
import DistributionTab from './DistributionTab'
import CompareTab from './CompareTab'
import HotTab from './HotTab'
import CourseTab from './CourseTab'
import KpCompareTab from './KpCompareTab'
import { useLocation } from 'react-router-dom'
import MethodologyButton from '../../stats/Methodology'
import { filterLabel, useStatsFilter } from '../../stats/StatsFilter'
import { Page } from '../../design'
import '../../design/page-analysis.css'

export default function Dashboard() {
  const { filter, ready } = useStatsFilter()
  const loc = useLocation()
  const [tab, setTab] = useState<string>(() => (loc.state as { tab?: string } | null)?.tab ?? 'dist')
  if (!ready) return null
  return (
    <Page data-testid="dashboard">
      <Tabs activeKey={tab} onChange={setTab} tabBarExtraContent={<span className="ewb-ana-pills" style={{ margin: 0 }}><span className="ewb-ana-meta" data-testid="dash-filter-label">{filterLabel(filter)}</span><MethodologyButton /></span>}
        items={[
          { key: 'dist', label: '分布', children: <DistributionTab /> },
          { key: 'compare', label: '同比', children: <CompareTab /> },
          { key: 'kpcompare', label: '知识点对比', children: <KpCompareTab /> },
          { key: 'hot', label: '重难点', children: <HotTab /> },
          { key: 'course', label: '课程对照', children: <CourseTab /> }
        ]} />
    </Page>
  )
}
