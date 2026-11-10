import React, { useState } from 'react'
import { Popover } from 'antd'
import { Check, ChevronDown } from 'lucide-react'
import { SUBJECT_LIST } from '../../shared/subject'
import { Icon } from '../design'
import { useSubject } from '../subject/SubjectContext'

/**
 * 侧栏顶部的学科切换（品牌下面）：窄栏里只放一个徽标（单字）加学科名，点开是一份三项的小菜单。
 * 当前学科决定试卷库、审核、看板、报告、课程、助手显示谁的数据；数据页和设置不分学科。
 */
export default function SubjectSwitch() {
  const { subject, def, setSubject } = useSubject()
  const [open, setOpen] = useState(false)
  const menu = (
    <div className="ewb-subject__menu" role="listbox" aria-label="学科" data-testid="subject-menu">
      <div className="ewb-subject__menu-title">当前学科</div>
      {SUBJECT_LIST.map(s => (
        <button key={s.id} type="button" role="option" aria-selected={s.id === subject} className="ewb-subject__opt" data-testid={`subject-opt-${s.id}`}
          onClick={() => { setSubject(s.id); setOpen(false) }}>
          <span className="ewb-subject__glyph" data-subject={s.id} aria-hidden>{s.short}</span>
          <span className="ewb-subject__name">{s.name}</span>
          {s.id === subject && <Icon as={Check} size={16} />}
        </button>
      ))}
    </div>
  )
  return (
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="rightTop" arrow={false} content={menu} classNames={{ root: 'ewb-subject__pop' }}>
      <button type="button" className="ewb-subject" data-testid="subject-switch" data-subject={subject} aria-haspopup="listbox" aria-expanded={open} aria-label={`当前学科：${def.name}，点击切换`}>
        <span className="ewb-subject__glyph" data-subject={subject} aria-hidden>{def.short}</span>
        <span className="ewb-subject__label">{def.name}<Icon as={ChevronDown} size={12} /></span>
      </button>
    </Popover>
  )
}
