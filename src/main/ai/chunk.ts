/** 流式生成时主进程发给界面的事件（通道 ai:chunk，只发给发起请求的那个窗口）。纯类型，P2 / P3 共用。 */
import type { CitationRef } from '../../shared/citation'

export type ChunkEvent =
  | { id: string; type: 'start'; scopeKey: string; refs: CitationRef[] }
  | { id: string; type: 'delta'; text: string }
  | { id: string; type: 'reset' }
  /** 推理模型正在「思考」（还没开始写正文）：seconds = 本次请求已用秒数，chars = 已思考的字数（思考内容本身不传） */
  | { id: string; type: 'thinking'; seconds: number; chars: number }
  /** 写不完，已把输出上限加大后自动重试（不需要用户操作）；界面提示一句即可 */
  | { id: string; type: 'retry'; reason: 'length' }
  | { id: string; type: 'done'; markdown: string; refs: CitationRef[]; warnings: string[]; reportId?: string; unverified?: UnverifiedItem[] }
  | { id: string; type: 'error'; code: string; message: string; detail?: string; partial: string }
  | { id: string; type: 'cancelled'; partial: string }

/** 事实核对里没能对上证据的句子（A3）：kind=conflict 是和已审核题目的解释明显矛盾，unverified 是证据里找不到依据 */
export interface UnverifiedItem { sentence: string; kind: 'unverified' | 'conflict'; reason: string; /** 家长版「我已核对」时，老师在确认框里勾了「已确认无误」（留痕） */ acknowledged?: boolean }
