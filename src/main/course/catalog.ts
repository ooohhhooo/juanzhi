/** 内置教材目录（已核对格式的版本）。目录文件在 src/main/seed/textbook-catalog/，随软件打包；格式有问题的版本直接不提供（单测会先报出来）。 */
import { CATALOG_RAW } from '../seed/textbook-catalog/index.ts'
import { SUBJECTS, isSubjectId } from '../../shared/subject.ts'
import type { CatalogEdition } from './textbook-builtin.ts'

const ok = (e: any): e is CatalogEdition =>
  !!e && typeof e.id === 'string' && isSubjectId(e.subject) && SUBJECTS[e.subject as keyof typeof SUBJECTS].textbooks.includes(e.textbookValue) && Array.isArray(e.books) && e.books.length > 0

export const CATALOG: CatalogEdition[] = (CATALOG_RAW as any[]).filter(ok)
export const findEdition = (id: string): CatalogEdition | undefined => CATALOG.find(e => e.id === id)
