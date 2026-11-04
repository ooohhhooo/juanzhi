import React from 'react'

/**
 * 助手页留给其他功能接入的两个位置（现在都是空的，空的时候页面上不显示）：
 *  - dataChips：对话顶部「已选数据」小标签区，数据集功能接入后在这里显示已选的数据；
 *  - board：右侧「看板」面板（约 400px，可折叠），看板功能接入后在这里显示；没有看板时整栏隐藏。
 * 接入方式：在自己的模块里调用 registerAssistantSlots({ board: MyBoard, dataChips: MyChips })，
 * 组件会收到当前对话的 id（新对话还没发出第一句时是 null）。
 */
export interface AssistantSlotProps { sessionId: string | null }
/** @ 提及列表里的一项：数据集或连接器（如某个企业微信群）。数据集 / 连接器功能接入后通过 mentionables 提供 */
export interface Mentionable { id: string; label: string; group: 'dataset' | 'connector' }
export interface AssistantSlots {
  /** 打 @ 时调用，返回可提及的数据集和连接器（剧本由助手页自己列出） */
  mentionables?: () => Promise<Mentionable[]>
  /** 输入框「＋」菜单里的数据入口：添加数据文件（调用数据集导入）/ 选择已有数据集；没接入时这两项置灰 */
  dataActions?: { addFiles?: () => void; pickDataset?: () => void; /** 选一个要发到外部（企业微信群）的文件，返回路径；只有这样选的文件才被允许发送 */ pickSendFile?: () => Promise<string | null>; /** 添加图片 / PDF / Word / 文本附件 */ addAttachments?: () => void; /** 输入框里粘贴的文件或截图 */ pasteFiles?: (files: File[]) => void }
  dataChips?: React.ComponentType<AssistantSlotProps>
  board?: React.ComponentType<AssistantSlotProps>
  boardTitle?: string
}

const slots: AssistantSlots = {}
export function registerAssistantSlots(s: AssistantSlots): void { Object.assign(slots, s) }
export const getAssistantSlots = (): AssistantSlots => slots
