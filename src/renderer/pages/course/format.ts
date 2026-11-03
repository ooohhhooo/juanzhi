/** 课程对照界面的小函数：场景用词、课次名。数据结构不随场景变，只有措辞变。 */
export type Scene = 'org' | 'school' | 'family' | 'other'

export const SCENE_LABEL: Record<Scene, string> = { org: '培训机构的课程', school: '学校的教学进度', family: '孩子在上的课', other: '其他' }
/** 场景下对“体系 / 级别”的叫法（只改措辞） */
export const SCENE_WORDS: Record<Scene, { outline: string; level: string; lesson: string }> = {
  org: { outline: '课程体系', level: '级别', lesson: '课' },
  school: { outline: '教学进度', level: '年级学期', lesson: '课（周次或单元）' },
  family: { outline: '课程表', level: '级别', lesson: '课' },
  other: { outline: '课程体系', level: '级别', lesson: '课' }
}

export const wordsOf = (scene: string) => SCENE_WORDS[(scene as Scene) in SCENE_WORDS ? (scene as Scene) : 'other']

/** 第 N 课《标题》（标题里已经写着“第 N 课”的，去掉重复的开头）。和主进程的 lessonName（course/map.ts）同一套规则 */
export function lessonText(l: { seq: number; noLabel?: string | null; title?: string | null }): string {
  const no = (l.noLabel ?? '').trim()
  const head = !no || /^\d+$/.test(no) ? `第 ${no || l.seq} 课` : no
  const raw = (l.title ?? '').trim()
  const esc = [...head.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
  const stripped = esc ? raw.replace(new RegExp(`^\\s*${esc}[\\s:：、.\\-—]*`), '') : raw
  const t = stripped.trim() ? stripped : raw
  return t && t !== head ? `${head}《${t.length > 24 ? t.slice(0, 24) + '…' : t}》` : head
}

/** 体系 · 级别 · 第 N 课《标题》（看板的课程胶囊） */
export const lessonFull = (l: { outlineName: string; levelName: string; seq: number; noLabel?: string | null; title?: string | null }): string => `${l.outlineName} · ${l.levelName} · ${lessonText(l)}`

export const CONF_LABEL: Record<string, string> = { high: '把握高', medium: '把握中', low: '把握低' }
