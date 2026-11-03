import React, { useEffect, useRef } from 'react'
import { App } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Btn } from '../design'
import { onReportNotice } from '../stats/reportStore'
import { READER_LABEL } from '../../shared/report-post'

/** 窗口不在前台时，额外发一条系统通知；点它把窗口带回来并跳转 */
function osNotify(title: string, body: string, onClick: () => void): void {
  try {
    if (!document.hidden && document.hasFocus()) return
    const n = new Notification(title, { body })
    n.onclick = () => { try { window.focus() } catch { /* 忽略 */ } onClick(); n.close() }
  } catch { /* 系统不让发通知就算了，应用内提示已经有了 */ }
}

/**
 * 全局完成提示（不论用户在哪个页面）：
 * 课程大纲后台整理变成「待核对」/「整理失败」，报告生成完成/失败（报告页自己在看时不重复弹）。
 */
export default function GlobalNotices(): null {
  const { notification } = App.useApp()
  const nav = useNavigate()
  const navRef = useRef(nav); navRef.current = nav
  const seen = useRef<Map<string, string> | null>(null)

  const { data: jobs } = useQuery({
    queryKey: ['course', 'jobs'], queryFn: () => window.api.course.jobs(),
    refetchInterval: q => ((q.state.data ?? []).some(j => j.status === 'queued' || j.status === 'running') ? 1500 : false)
  })
  useEffect(() => {
    if (!jobs) return
    const prev = seen.current
    seen.current = new Map(jobs.map(j => [j.id, j.status]))
    if (!prev) return   // 第一次读到：只记状态，不弹
    for (const j of jobs) {
      const was = prev.get(j.id)
      if (was !== 'queued' && was !== 'running') continue
      if (j.status !== 'ready' && j.status !== 'failed') continue
      const key = `course-job-${j.id}`
      const go = () => navRef.current('/courses')
      if (j.status === 'ready') {
        const text = `课程大纲「${j.name || j.fileName}」整理好了，去核对`
        notification.success({ key, message: text, duration: 8, placement: 'topRight',
          description: <Btn tone="primary" size="small" data-testid="notice-course-go" onClick={() => { notification.destroy(key); go() }}>去核对</Btn> })
        osNotify('课程大纲整理好了', `「${j.name || j.fileName}」可以去核对了`, go)
      } else {
        const text = `整理失败：${j.error || '没有整理成功'}`
        notification.error({ key, message: `课程大纲「${j.name || j.fileName}」`, description: <span data-testid="notice-course-fail">{text}</span>, duration: 10, placement: 'topRight' })
        osNotify('课程大纲整理失败', text, go)
      }
    }
  }, [jobs])

  useEffect(() => onReportNotice((n, pageMounted) => {
    const go = () => navRef.current('/report')
    const label = READER_LABEL[n.reader]
    if (n.kind === 'done') {
      if (!pageMounted) {
        const key = `report-done-${n.requestId}`
        notification.success({ key, message: `${label}已生成`, duration: 8, placement: 'topRight',
          description: <Btn tone="primary" size="small" data-testid="notice-report-go" onClick={() => { notification.destroy(key); go() }}>查看</Btn> })
      }
      osNotify('报告已生成', `${label}已生成`, go)
    } else {
      if (!pageMounted) notification.error({ message: `${label}生成失败`, description: <span data-testid="notice-report-fail">{n.message}</span>, duration: 10, placement: 'topRight' })
      osNotify('报告生成失败', n.message, go)
    }
  }), [])
  return null
}
