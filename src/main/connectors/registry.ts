import type { Connector } from './types'
import { wecom } from './wecom'
import { mcp } from './mcp'

/** 以后接飞书、钉钉：新建一个 Connector 加到这里 */
export const CONNECTORS: Connector[] = [wecom, mcp]
export const getConnector = (id: string): Connector | undefined => CONNECTORS.find(c => c.id === id)
