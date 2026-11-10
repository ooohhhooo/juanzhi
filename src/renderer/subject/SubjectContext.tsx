import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SUBJECT, SUBJECTS, asSubject, type SubjectDef, type SubjectId } from '../../shared/subject'

/** 设置里记住当前学科的键（主进程白名单已放行） */
export const SUBJECT_SETTING_KEY = 'current_subject'

interface Ctx {
  subject: SubjectId
  def: SubjectDef
  /** 已从设置读到上次的学科 */
  ready: boolean
  setSubject: (s: SubjectId) => void
}
// 没有 Provider 时（设计样张、单测）按英语处理，免得到处判空
const SubjectCtx = createContext<Ctx>({ subject: DEFAULT_SUBJECT, def: SUBJECTS[DEFAULT_SUBJECT], ready: true, setSubject: () => undefined })

/**
 * 当前学科（侧栏顶部的全局切换）：存在 settings.current_subject，重启后记住。
 * 读到之前先不渲染子树，免得先按英语发一轮请求、再按真正的学科重发。
 */
export function SubjectProvider({ children }: { children: React.ReactNode }) {
  const [subject, setSubjectState] = useState<SubjectId>(DEFAULT_SUBJECT)
  const [ready, setReady] = useState(false)
  const touched = useRef(false)   // 用户在读取完成前已经切过：以用户的为准

  useEffect(() => {
    let alive = true
    if (!window.api?.settings) { setReady(true); return }
    window.api.settings.get(SUBJECT_SETTING_KEY).then(v => {
      if (!alive) return
      if (!touched.current) setSubjectState(asSubject(v))
      setReady(true)
    }, () => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [])

  const setSubject = useCallback((s: SubjectId) => {
    touched.current = true
    setSubjectState(s)
    window.api?.settings?.set(SUBJECT_SETTING_KEY, s)?.catch(() => { /* 存不上只是重启后不记得 */ })
  }, [])

  const value = useMemo<Ctx>(() => ({ subject, def: SUBJECTS[subject], ready, setSubject }), [subject, ready, setSubject])
  return <SubjectCtx.Provider value={value}>{ready ? children : null}</SubjectCtx.Provider>
}

export function useSubject(): Ctx {
  return useContext(SubjectCtx)
}

/** 默认教材在设置里的键：英语沿用 default_textbook，其余学科各存一份 */
export const defaultTextbookKey = (s: SubjectId): string => (s === 'english' ? 'default_textbook' : `default_textbook.${s}`)
