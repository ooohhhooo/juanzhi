import React, { useState } from 'react'
import { Tabs } from 'antd'
import DistributionTab from './DistributionTab'
import CompareTab from './CompareTab'
import HotTab from './HotTab'
import MethodologyButton from '../../stats/Methodology'
import { filterLabel, useStatsFilter } from '../../stats/StatsFilter'

export default function Dashboard() {
  const { filter, ready } = useStatsFilter()
  const [tab, setTab] = useState('dist')
  if (!ready) return null
  return (
    <div data-testid="dashboard">
      <Tabs activeKey={tab} onChange={setTab} style={{ padding: '0 20px' }} tabBarExtraContent={<span><span style={{ fontSize: 12, color: '#888', marginRight: 8 }} data-testid="dash-filter-label">{filterLabel(filter)}</span><MethodologyButton /></span>}
        items={[
          { key: 'dist', label: '分布', children: <DistributionTab /> },
          { key: 'compare', label: '同比', children: <CompareTab /> },
          { key: 'hot', label: '重难点', children: <HotTab /> }
        ]} />
    </div>
  )
}
