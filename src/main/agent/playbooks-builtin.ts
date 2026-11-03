/**
 * 内置剧本：用 ?raw 导入，打包时直接进主进程代码，不依赖运行时的文件路径。
 * 新增内置剧本：把 .md 放进 playbooks/，在这里 import 并加进数组（单测会核对 playbooks/ 里的文件都登记了）。
 */
import { parsePlaybook } from './playbooks.ts'
import type { Playbook } from './playbooks.ts'
import weeklyReport from './playbooks/weekly-report.md?raw'

const RAW: string[] = [weeklyReport]

export const BUILTIN_PLAYBOOKS: Playbook[] = RAW.map(t => parsePlaybook(t, 'builtin')).filter((p): p is Playbook => !!p)
