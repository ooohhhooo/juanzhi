import { useMemo } from 'react'
import { categoriesOf, categoryByKeyOf, categoryOfCode, type Category, type CategoryKey } from '../design/tokens'
import { useSubject } from './SubjectContext'

/** 当前学科的知识大类：列表（按色槽顺序）、按色槽名查、按知识点代码归类 */
export function useCategories(): { list: Category[]; byKey: Record<CategoryKey, Category>; ofCode: (code: string | null | undefined) => CategoryKey | null } {
  const { subject } = useSubject()
  return useMemo(() => ({
    list: categoriesOf(subject),
    byKey: categoryByKeyOf(subject),
    ofCode: (code: string | null | undefined) => categoryOfCode(code, subject)
  }), [subject])
}
