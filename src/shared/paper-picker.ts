/**
 * 筛选栏「试卷」多选下拉的选项规则（不依赖 electron / React，单测直接跑）。
 * 只列「会被计入统计」的卷子：状态已确认（打开「含待审核」则含待审核）、不是疑似重复、与「示例 / 真实」开关一致；
 * 同一个文件导入多份时只列代表卷（已确认的优先，再取最早导入的），和主进程 paperScope 的去重规则一致。
 * 没有选卷子时，年级 / 学期 / 学年等维度筛选会缩小下拉里的范围。
 */

export interface PickerPaper {
  id: string
  title: string
  file_name: string
  school: string | null
  status: string
  grade: string | null
  semester: string | null
  school_year_start: number | null
  exam_type: string | null
  textbook: string | null
  region: string | null
  file_hash?: string
  created_at?: string
  is_sample?: number
  similar_state?: 'suspect' | 'accepted' | null
}

export interface PickerScope {
  sample?: boolean
  includeReviewing?: boolean
  includeDuplicates?: boolean
  grade?: string
  semester?: string
  school_year_start?: number
  exam_type?: string
  textbook?: string
  region?: string
}

const GRADE_LABEL = ['', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级']

export interface PickerOption { value: string; label: string; status: string; search: string }

export function pickerOptions(papers: PickerPaper[], scope: PickerScope, narrowByDims: boolean): PickerOption[] {
  let list = papers.filter(p => !!p.is_sample === !!scope.sample
    && (p.status === 'done' || (!!scope.includeReviewing && p.status === 'reviewing'))
    && (scope.includeDuplicates || p.similar_state !== 'suspect'))
  if (!scope.includeDuplicates) {
    const best = new Map<string, PickerPaper>()
    for (const p of list) {
      const key = p.file_hash || p.id
      const cur = best.get(key)
      const rank = (x: PickerPaper) => (x.status === 'done' ? 0 : 1)
      if (!cur || rank(p) < rank(cur) || (rank(p) === rank(cur) && (p.created_at ?? '') < (cur.created_at ?? ''))) best.set(key, p)
    }
    list = list.filter(p => best.get(p.file_hash || p.id) === p)
  }
  if (narrowByDims) {
    list = list.filter(p => (!scope.grade || p.grade === scope.grade)
      && (!scope.semester || p.semester === scope.semester)
      && (scope.school_year_start === undefined || p.school_year_start === scope.school_year_start)
      && (!scope.exam_type || p.exam_type === scope.exam_type)
      && (!scope.textbook || p.textbook === scope.textbook)
      && (!scope.region || p.region === scope.region))
  }
  list = [...list].sort((a, b) => (b.school_year_start ?? 0) - (a.school_year_start ?? 0)
    || (a.grade ?? '').localeCompare(b.grade ?? '') || (a.semester ?? '').localeCompare(b.semester ?? '')
    || (a.title || a.file_name).localeCompare(b.title || b.file_name, 'zh-Hans-CN', { numeric: true }))
  return list.map(p => {
    const title = p.title || p.file_name
    const meta = [p.grade ? GRADE_LABEL[Number(p.grade)] + (p.semester ?? '') : '', p.school_year_start ? `${p.school_year_start}-${p.school_year_start + 1}` : ''].filter(Boolean).join('　·　')
    return {
      value: p.id,
      label: `${title}${meta ? `　·　${meta}` : ''}`,
      status: p.status === 'done' ? '已确认' : '待审核',
      search: `${title} ${p.school ?? ''}`.toLowerCase()
    }
  })
}

/** 搜索：标题或学校里含搜索词（不分大小写） */
export const pickerMatches = (o: Pick<PickerOption, 'search'>, query: string): boolean => {
  const q = query.trim().toLowerCase()
  return !q || o.search.includes(q)
}
