/**
 * 识别教材的出版社、年级、学期（封面 / 版权页 / 目录页的文字 + 文件名），并接「内置教材目录」。纯函数 + 一个登记口，单测直接加载。
 *
 * 内置教材目录（src/main/seed/textbook-catalog/，按 edition + grade + semester 查）由另一个子任务做；
 * 这里只定义接口：合并时在启动处调用 setCatalogProvider({ find, units }) 即可。没有登记就不会出现「用内置目录」的提示。
 */
export interface EditionInfo {
  /** 版本名，如「人教版」「外研版」 */
  edition: string
  grade: number
  /** 1 = 上册 / 第一学期，2 = 下册 / 第二学期；认不出为 null */
  semester: 1 | 2 | null
  /** 给人看的：人教版 三年级上册 */
  label: string
}

const PUBLISHERS: Array<[RegExp, string]> = [
  [/统编|部编/, '统编版'],
  [/PEP/i, '人教版'],
  [/人民教育出版社|人教/, '人教版'],
  [/外语教学与研究出版社|外研/, '外研版'],
  [/译林/, '译林版'],
  [/北京师范大学出版社|北师大/, '北师大版'],
  [/江苏凤凰教育出版社|苏教/, '苏教版'],
  [/上海教育出版社|沪教/, '沪教版'],
  [/河北教育出版社|冀教/, '冀教版'],
  [/西南大学出版社|西南师范大学出版社|西师/, '西师版'],
  [/北京出版社/, '北京版'],
  [/青岛出版社|青岛版/, '青岛版'],
  [/浙江教育出版社|浙教/, '浙教版']
]
const CN_GRADE: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 从一段文字里认出版本 + 年级（必须都有）+ 学期（可缺）；认不出返回 null */
export function detectEdition(text: string): EditionInfo | null {
  const t = text.replace(/\s+/g, '')
  const pub = PUBLISHERS.find(([re]) => re.test(t))
  if (!pub) return null
  let grade: number | null = null
  const g1 = /([一二三四五六七八九])年级/.exec(t)
  const g2 = /(?:grade|Grade|GRADE)(\d)/.exec(t)
  const g3 = /([1-9])年级/.exec(t)
  if (g1) grade = CN_GRADE[g1[1]]
  else if (g2) grade = Number(g2[1])
  else if (g3) grade = Number(g3[1])
  if (!grade) return null
  const semester: 1 | 2 | null = /上册|第一学期|(?:book|Book)1(?!\d)/.test(t) ? 1 : /下册|第二学期|(?:book|Book)2(?!\d)/.test(t) ? 2 : null
  // 青岛版分六三制、五四制两套：认得出「五四」就是五四制，否则按用得多的六三制
  const edition = pub[1] === '青岛版' ? (/五[·•・]?四(学)?制/.test(t) ? '青岛版（五四制）' : '青岛版（六三制）') : pub[1]
  const label = `${edition} ${['', '一', '二', '三', '四', '五', '六', '七', '八', '九'][grade]}年级${semester === 1 ? '上册' : semester === 2 ? '下册' : ''}`
  return { edition, grade, semester, label }
}

export interface CatalogUnit {
  title: string
  pageStart?: number
  pageEnd?: number
  /** 知识点代码（当前学科的知识点树里的） */
  kps: string[]
}
export interface CatalogQuery { subject: string; edition: string; grade: number; semester: 1 | 2 | null }
export interface CatalogProvider {
  /** 有这一册就返回 id 和名称，没有返回 null */
  find(q: CatalogQuery): { id: string; label: string } | null
  units(id: string): CatalogUnit[]
}

let provider: CatalogProvider | null = null
export function setCatalogProvider(p: CatalogProvider | null): void { provider = p }
export const getCatalogProvider = (): CatalogProvider | null => provider

/** 有内置目录就返回（界面据此提示「软件里已经内置了这一册的目录，直接用内置的？」） */
export function findBuiltinCatalog(subject: string, info: EditionInfo | null): { id: string; label: string } | null {
  if (!provider || !info || !info.semester) return null
  try { return provider.find({ subject, edition: info.edition, grade: info.grade, semester: info.semester }) } catch { return null }
}
