/**
 * 交互界面入口：`juanzhi`（终端里不带参数）或 `juanzhi chat`。
 * Ink 是纯 ESM 包（模块顶层有 await），主进程的 CJS 包不能 require 它，所以用动态 import 加载。
 */
import { createElement } from 'react'
import { Engine } from './engine'
import type { EngineDeps, RunCliFail, RunCliResult } from './engine'
import { createApp } from './app'
import type { UiBridge } from './app'

export interface TuiOptions {
  runCli: (argv: string[], log: (m: string) => void) => Promise<RunCliResult | RunCliFail>
}

export const noColorWanted = (): boolean => 'NO_COLOR' in process.env || process.env.TERM === 'dumb'

/** 跑到用户退出为止 */
export async function runTui(o: TuiOptions): Promise<void> {
  const ink = await import('ink')
  const bridge: UiBridge = { choose: null, progress: null, exit: () => undefined }
  let instance: ReturnType<typeof ink.render> | null = null
  let engine!: Engine
  const deps: EngineDeps = {
    runCli: o.runCli,
    choose: (t, opts) => (bridge.choose ? bridge.choose(t, opts) : Promise.resolve(null)),
    progress: t => bridge.progress?.(t),
    exit: () => bridge.exit(),
    clearScreen: () => {
      try { process.stdout.write('\x1b[2J\x1b[3J\x1b[H') } catch { /* 终端没了 */ }
      engine.model.clearItems()
      engine.model.add({ kind: 'banner', banner: engine.banner() })
    },
    changed: () => engine.model.refresh()
  }
  engine = new Engine(deps)
  const done = new Promise<void>(resolve => { bridge.exit = () => { instance?.unmount(); resolve() } })
  engine.model.add({ kind: 'banner', banner: engine.banner() })
  const App = createApp(ink, engine, bridge, { noColor: noColorWanted() })
  instance = ink.render(createElement(App), { exitOnCtrlC: false, patchConsole: false })
  await done
  engine.stop()
  engine.dispose()
}
