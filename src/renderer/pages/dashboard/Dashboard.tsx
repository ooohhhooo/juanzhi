import React, { useState } from 'react'
import { Tabs } from 'antd'
import DistributionTab from './DistributionTab'
import CompareTab from './CompareTab'
import HotTab from './HotTab'
import MethodologyButton from '../../stats/Methodology'
import { filterLabel, useStatsFilter } from '../../stats/StatsFilter'
import { Page } from '../../design'
import '../../design/page-analysis.css'

export default function Dashboard() {
  const { filter, ready } = useStatsFilter()
  const [tab, setTab] = useState('dist')
  if (!ready) return null
  return (
    <Page data-testid="dashboard">
      <Tabs activeKey={tab} onChange={setTab} tabBarExtraContent={<span className="ewb-ana-pills" style={{ margin: 0 }}><span className="ewb-ana-meta" data-testid="dash-filter-label">{filterLabel(filter)}</span><MethodologyButton /></span>}
        items={[
          { key: 'dist', label: '分布', children: <DistributionTab /> },
          { key: 'compare', label: '同比', children: <CompareTab /> },
          { key: 'hot', label: '重难点', children: <HotTab /> }
        ]} />
    </Page>
  )
}
