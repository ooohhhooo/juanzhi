/**
 * 用法框 <UsageNote>：对应词典里的「易混辨析 / 注意」框。
 * 用于易错提醒、辨析（time for / time to）、样本不足提示、重复导入提醒、AI 失败。
 * 样式：1px 边框 + 信息框底色，左上角一个小标签；「易错」是红色实心标签。不用左侧粗色边条。
 */
import React from 'react'

export type UsageKind = 'mistake' | 'contrast' | 'caution' | 'tip'

/** 四种用法框的标签文字 */
export const USAGE_LABEL: Record<UsageKind, string> = { mistake: '易错', contrast: '辨析', caution: '注意', tip: '提示' }

export interface UsageNoteProps {
  /**
   * mistake 易错（红）：学生常错的点，或需要处理的失败；
   * contrast 辨析：两个容易混的用法并排讲清；
   * caution 注意：样本不足、重复导入等需要读者留意的事；
   * tip 提示：怎么用、下一步做什么。
   */
  kind: UsageKind
  /** 加粗的一句标题（可选），如「time for / time to」 */
  title?: React.ReactNode
  /** 正文 */
  children: React.ReactNode
  /** 底部操作区。失败时只放一个「重试」 */
  actions?: React.ReactNode
  /** 覆盖标签文字（默认按 kind） */
  label?: string
  'data-testid'?: string
}

export default function UsageNote({ kind, title, children, actions, label, ...rest }: UsageNoteProps) {
  const text = label ?? USAGE_LABEL[kind]
  return (
    <aside className={`ewb-note ewb-note--${kind}`} role={kind === 'mistake' ? 'alert' : 'note'} aria-label={text} data-testid={rest['data-testid']}>
      <span className="ewb-note__label" aria-hidden>{text}</span>
      {title && <p className="ewb-note__title">{title}</p>}
      <div className="ewb-note__body">{children}</div>
      {actions && <div className="ewb-note__actions">{actions}</div>}
    </aside>
  )
}
