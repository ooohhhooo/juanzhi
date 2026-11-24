/** 回答完成后的挂钩（service.ts 调用）：记指纹和用户信号、判断要不要提示「存成 Skill」。出错不影响助手本身 */
import path from 'node:path'
import { getDb, getDataDir } from '../../db'
import { listUserSkillFiles } from '../playbooks/manage'
import { recordTurn } from './store'

export function afterTurn(sessionId: string): void {
  try {
    const names = listUserSkillFiles(path.join(getDataDir(), 'playbooks')).map(f => f.playbook.name)
    recordTurn(getDb(), sessionId, { userSkills: names })
  } catch (e) { console.warn('[skills] 记录回答失败:', (e as Error).message) }
}
