/**
 * 内置剧本入口：打包时 ?raw 把 *.md 原文编进主进程（与 ai/prompts.ts 同一种写法）。
 * 新增内置剧本要在这里加一行 import 和一项（单测会核对目录里的 .md 和这里一一对应）。
 * 用户剧本放在 <数据目录>/playbooks/*.md，同名覆盖内置的。
 */
import attendanceLateness from './attendance-lateness.md?raw'
import learningWeekly from './learning-weekly.md?raw'
import refundReasons from './refund-reasons.md?raw'
import renewal from './renewal.md?raw'
import shareCards from './share-cards.md?raw'
import satisfactionNps from './satisfaction-nps.md?raw'
import studentFollowupList from './student-followup-list.md?raw'
import weeklyReport from './weekly-report.md?raw'
import { createPlaybooks } from './store.ts'

export const BUILTIN_PLAYBOOK_FILES: Record<string, string> = {
  './attendance-lateness.md': attendanceLateness,
  './learning-weekly.md': learningWeekly,
  './refund-reasons.md': refundReasons,
  './renewal.md': renewal,
  './satisfaction-nps.md': satisfactionNps,
  './share-cards.md': shareCards,
  './student-followup-list.md': studentFollowupList,
  './weekly-report.md': weeklyReport
}

const pb = createPlaybooks(BUILTIN_PLAYBOOK_FILES)
export const listPlaybooks = pb.listPlaybooks
export const loadPlaybook = pb.loadPlaybook
export const playbookProblems = pb.playbookProblems
export const allPlaybooks = pb.allPlaybooks
export { createPlaybooks, userPlaybookDir, readPlaybookFiles } from './store.ts'
export type { PlaybookInfo, LoadedPlaybook } from './store.ts'
