/** @jsxImportSource react */
/**
 * 交互界面（Ink）。Ink 只有 ESM 版本、模块顶层用了 await，打进主进程的 CJS 包里没法 require，
 * 所以这里不直接 import 'ink'，而是由 index.ts 动态 import 之后传进 createApp，组件都在工厂函数里定义。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type * as InkNS from 'ink'
import type { Engine, Choice } from './engine'
import { MODE_LABEL } from './engine'
import { fmtMs, fmtUsage } from './chat-model'
import type { Item, PlanRow, Pending } from './chat-model'
import { clipWidth, parseMarkdown, tableFallback, tableLines, textWidth } from './markdown'
import type { MdBlock, Span } from './markdown'
import { matchSlash, parseSlash, splitPaths } from './slash-defs'
import * as ed from './editor'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Ink = typeof InkNS

export interface UiBridge {
  /** App 挂载后填入：弹出选择 / 显示进度 */
  choose: (<T>(title: string, options: Array<Choice<T>>) => Promise<T | null>) | null
  progress: ((text: string | null) => void) | null
  exit: () => void
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function createApp(ink: Ink, engine: Engine, bridge: UiBridge, o: { noColor: boolean }) {
  const { Box, Text, Static, useInput, usePaste, useStdout } = ink
  const ACCENT = o.noColor ? undefined : '#8F94FF'
  const OK = o.noColor ? undefined : 'green'
  const WARN = o.noColor ? undefined : 'yellow'
  const ERR = o.noColor ? undefined : 'red'
  const TONE = { info: undefined, ok: OK, warn: WARN, error: ERR } as const
  const MARK = { info: '·', ok: '✓', warn: '!', error: '✗' } as const

  const useTick = (active: boolean, ms = 120): number => {
    const [n, setN] = useState(0)
    useEffect(() => {
      if (!active) return
      const t = setInterval(() => setN(x => x + 1), ms)
      return () => clearInterval(t)
    }, [active, ms])
    return n
  }
  const useCols = (): number => {
    const stdout = useStdout().stdout as unknown as NodeJS.WriteStream
    const [c, setC] = useState(stdout.columns || 80)
    useEffect(() => {
      const f = (): void => setC(stdout.columns || 80)
      stdout.on('resize', f)
      return () => { stdout.off('resize', f) }
    }, [stdout])
    return c
  }

  // ───────── Markdown ─────────
  const Spans = ({ spans, dim }: { spans: Span[]; dim?: boolean }) => (
    <>{spans.map((s, i) => <Text key={i} bold={s.b} italic={s.i} dimColor={dim || s.dim} color={s.code ? ACCENT : undefined}>{s.code ? `\`${s.t}\`` : s.t}</Text>)}</>
  )
  const Md = ({ md, width }: { md: string; width: number }) => {
    const blocks = parseMarkdown(md)
    return (
      <Box flexDirection="column">
        {blocks.map((b, i) => <Block key={i} b={b} width={width} gap={i > 0 && blocks[i - 1].k !== 'li' || (i > 0 && b.k !== 'li')} />)}
      </Box>
    )
  }
  const Block = ({ b, width, gap }: { b: MdBlock; width: number; gap: boolean }) => {
    const mt = gap ? 1 : 0
    switch (b.k) {
      case 'h': return <Box marginTop={mt}><Text bold color={b.level <= 2 ? ACCENT : undefined}><Spans spans={b.spans} /></Text></Box>
      case 'p': return <Box marginTop={mt}><Text><Spans spans={b.spans} /></Text></Box>
      case 'li': return (
        <Box paddingLeft={b.depth * 2}>
          <Box width={textWidth(b.marker) + 1} flexShrink={0}><Text color={ACCENT}>{b.marker}</Text></Box>
          <Box flexShrink={1}><Text><Spans spans={b.spans} /></Text></Box>
        </Box>
      )
      case 'quote': return <Box><Text dimColor>▎ </Text><Box flexShrink={1}><Text dimColor><Spans spans={b.spans} /></Text></Box></Box>
      case 'code': return (
        <Box marginTop={mt} flexDirection="column" paddingLeft={1}>
          {b.lines.map((l, i) => <Text key={i} dimColor>│ {l}</Text>)}
        </Box>
      )
      case 'hr': return <Box marginTop={mt}><Text dimColor>{'─'.repeat(Math.max(8, Math.min(width, 48)))}</Text></Box>
      case 'table': {
        const lines = tableLines(b, width)
        return (
          <Box marginTop={mt} flexDirection="column">
            {lines
              ? lines.map((l, i) => <Text key={i} bold={i === 1} dimColor={i !== 1 && (i === 0 || i === 2 || i === lines.length - 1)}>{l}</Text>)
              : tableFallback(b).map((l, i) => <Box key={i}><Text color={ACCENT}>▸ </Text><Box flexShrink={1}><Text>{l}</Text></Box></Box>)}
          </Box>
        )
      }
    }
  }

  // ───────── 已定下来的内容 ─────────
  const PlanView = ({ items }: { items: PlanRow[] }) => (
    <Box flexDirection="column" paddingLeft={2}>
      {items.map((p, i) => (
        <Text key={i} dimColor={p.status === 'done'} bold={p.status === 'doing'} color={p.status === 'done' ? OK : p.status === 'doing' ? ACCENT : undefined}>
          {p.status === 'done' ? '✔' : p.status === 'doing' ? '◐' : '○'} {p.content}
        </Text>
      ))}
    </Box>
  )

  const BannerView = ({ item, cols }: { item: Extract<Item, { kind: 'banner' }>; cols: number }) => {
    const b = item.banner
    const w = Math.max(30, Math.min(cols, 96))
    const narrow = cols < 60
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={w}>
        <Text><Text color={ACCENT} bold>✦ 卷知</Text><Text dimColor>  v{b.version}</Text></Text>
        {!narrow && <Text dimColor wrap="truncate-middle">{b.dataDir}</Text>}
        <Box marginTop={1} flexDirection="column">
          {b.model
            ? <Text><Text dimColor>模型  </Text>{b.model}</Text>
            : <Text color={WARN}>还没有配置 AI：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写</Text>}
          <Text><Text dimColor>试卷  </Text>{b.papers} 份，已解析 {b.parsed} 份<Text dimColor>  ·  </Text><Text dimColor>数据集  </Text>{b.datasets} 个</Text>
          <Text><Text dimColor>助手  </Text><Text color={ACCENT}>{b.role}</Text></Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>· 直接输入问题，和助手对话</Text>
          <Text dimColor>· 输入 / 查看命令</Text>
          {!narrow && <Text dimColor>· 把文件路径拖进来可以导入试卷</Text>}
        </Box>
      </Box>
    )
  }

  const ItemView = ({ item, cols }: { item: Item; cols: number }) => {
    switch (item.kind) {
      case 'banner': return <BannerView item={item} cols={cols} />
      case 'user': return <Box marginTop={1}><Text color={ACCENT} bold>❯ </Text><Box flexShrink={1}><Text>{item.text}</Text></Box></Box>
      case 'text': return <Box marginTop={1}><Text color={ACCENT}>● </Text><Box flexShrink={1} flexDirection="column"><Md md={item.md} width={cols - 4} /></Box></Box>
      case 'md': return <Box marginTop={1} paddingLeft={2} flexDirection="column"><Md md={item.md} width={cols - 4} /></Box>
      case 'tool': return (
        <Text wrap="truncate-end">
          <Text color={item.ok ? OK : ERR}>{item.ok ? '  ✓ ' : '  ✗ '}</Text>
          <Text bold>{item.label}</Text>
          {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
          {item.summary ? <Text dimColor>  ·  {item.summary}</Text> : null}
          {item.ms ? <Text dimColor>  ·  {fmtMs(item.ms)}</Text> : null}
        </Text>
      )
      case 'plan': return <Box marginTop={1} flexDirection="column"><Text dimColor>  计划</Text><PlanView items={item.items} /></Box>
      case 'notice': return <Box marginTop={0} paddingLeft={2}><Text color={TONE[item.tone]}>{MARK[item.tone]} </Text><Box flexShrink={1}><Text color={TONE[item.tone]} dimColor={item.tone === 'info'}>{item.text}</Text></Box></Box>
      case 'lines': return (
        <Box marginTop={1} flexDirection="column" paddingLeft={2}>
          {item.title ? <Text bold color={ACCENT}>{item.title}</Text> : null}
          {item.lines.map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)}
        </Box>
      )
    }
  }

  // ───────── 选择 ─────────
  interface SelectProps {
    title: string; options: Array<{ label: string; hint?: string }>; initial?: number
    onPick: (i: number | null) => void
    /** 最后多一项「自己写」，选中后在这里输入文字 */
    other?: { label: string; onText: (t: string) => void }
    keys?: Record<string, number>
    children?: ReactNode
    cols: number
  }
  const Select = ({ title, options, initial = 0, onPick, other, keys, children, cols }: SelectProps) => {
    const total = options.length + (other ? 1 : 0)
    const [sel, setSel] = useState(Math.min(initial, total - 1))
    const [typing, setTyping] = useState(false)
    const [text, setText] = useState(ed.empty())
    useInput((input, key) => {
      if (typing) {
        if (key.escape) { setTyping(false); return }
        if (key.return) { const t = text.text.trim(); if (t) other!.onText(t); return }
        if (key.leftArrow) setText(ed.left(text))
        else if (key.rightArrow) setText(ed.right(text))
        else if (key.backspace || key.delete) setText(ed.backspace(text))
        else if (input && !key.ctrl && !key.meta) setText(ed.insert(text, input))
        return
      }
      if (key.escape || (key.ctrl && input === 'c')) { onPick(null); return }
      if (key.upArrow) setSel(s => (s + total - 1) % total)
      else if (key.downArrow || key.tab) setSel(s => (s + 1) % total)
      else if (key.return) { if (other && sel === options.length) setTyping(true); else onPick(sel) }
      else if (keys && keys[input.toLowerCase()] !== undefined) onPick(keys[input.toLowerCase()])
      else if (/^[1-9]$/.test(input) && Number(input) <= total) {
        const i = Number(input) - 1
        if (other && i === options.length) setTyping(true); else onPick(i)
      }
    })
    const view = ed.viewLines(text)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={Math.min(cols, 96)}>
        <Text bold>{title}</Text>
        {children}
        <Box flexDirection="column" marginTop={children ? 1 : 0}>
          {options.map((op, i) => (
            <Text key={i} color={i === sel && !typing ? ACCENT : undefined} bold={i === sel && !typing}>
              {i === sel && !typing ? '❯ ' : '  '}{i + 1}. {op.label}{op.hint ? <Text dimColor>  {op.hint}</Text> : null}
            </Text>
          ))}
          {other && (
            <Text color={sel === options.length ? ACCENT : undefined} bold={sel === options.length}>
              {sel === options.length ? '❯ ' : '  '}{options.length + 1}. {other.label}
            </Text>
          )}
        </Box>
        {typing && (
          <Box marginTop={1}>
            <Text color={ACCENT}>❯ </Text>
            <Box flexDirection="column" flexShrink={1}>
              {view.map((l, i) => 'plain' in l ? <Text key={i}>{l.plain || ' '}</Text> : <Text key={i}>{l.before}<Text inverse>{l.at}</Text>{l.after}</Text>)}
            </Box>
          </Box>
        )}
        <Text dimColor>{typing ? 'Enter 发送 · Esc 返回' : `↑↓ 选择 · Enter 确认 · Esc 取消${keys ? ' · ' + Object.keys(keys).join(' / ') : ''}`}</Text>
      </Box>
    )
  }

  const PendingView = ({ p, cols }: { p: Pending; cols: number }) => {
    if (p.type === 'ask') {
      const opts = p.options.map(label => ({ label }))
      return (
        <Select
          cols={cols} title={p.planReview ? '要按这个计划做吗？' : p.question} options={opts}
          other={p.allowOther ? { label: p.planReview ? '提修改意见……' : '其他（自己写）……', onText: t => engine.answer(p.id, t) } : undefined}
          onPick={i => { if (i === null) engine.stop(); else engine.answer(p.id, p.options[i]) }}
        />
      )
    }
    const preview = (p.content ?? '').split('\n').slice(0, 12)
    const more = (p.content ?? '').split('\n').length - preview.length
    return (
      <Select
        cols={cols} title="需要你确认" initial={p.privacyWarning ? 1 : 0}
        options={[{ label: '同意' }, { label: '拒绝' }]} keys={{ y: 0, n: 1 }}
        onPick={i => engine.approve(p.id, i === 0)}
      >
        <Text>{p.summary}</Text>
        {p.target ? <Text><Text dimColor>发往  </Text>{p.target}</Text> : null}
        {p.privacyWarning ? <Text color={WARN}>! {p.privacyWarning}</Text> : null}
        {preview.length > 0 && p.content ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            {preview.map((l, i) => <Text key={i} dimColor wrap="truncate-end">│ {l}</Text>)}
            {more > 0 ? <Text dimColor>│ ……还有 {more} 行</Text> : null}
          </Box>
        ) : null}
      </Select>
    )
  }

  // ───────── 正在发生的 ─────────
  const tailRows = (text: string, width: number, rows: number): string => {
    const lines = text.split('\n')
    const out: string[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0 && used < rows; i--) {
      used += Math.max(1, Math.ceil(textWidth(lines[i]) / Math.max(10, width)))
      out.unshift(lines[i])
    }
    return out.join('\n')
  }

  const LiveView = ({ cols, version }: { cols: number; version: number }) => {
    const m = engine.model
    const live = m.live
    const tick = useTick(live.running)
    void version
    if (!live.running) return null
    const secs = fmtMs(Date.now() - live.runStartedAt)
    const spin = SPIN[tick % SPIN.length]
    return (
      <Box flexDirection="column">
        {live.plan.length > 0 && <Box marginTop={1} flexDirection="column"><Text dimColor>  计划</Text><PlanView items={live.plan} /></Box>}
        {live.stream.trim() && (
          <Box marginTop={1}><Text color={ACCENT}>● </Text><Box flexShrink={1} flexDirection="column"><Md md={tailRows(live.stream, cols - 4, 8)} width={cols - 4} /></Box></Box>
        )}
        {live.tools.map(t => (
          <Text key={t.id} wrap="truncate-end">
            <Text color={ACCENT}>{`  ${spin} `}</Text><Text bold>{t.label}</Text>
            {t.hint ? <Text dimColor>  {t.hint}</Text> : null}
            {t.total ? <Text dimColor>  {t.done ?? 0}/{t.total}</Text> : null}
            <Text dimColor>  {fmtMs(Date.now() - t.t0)}</Text>
          </Text>
        ))}
        {!live.pending && <Box marginTop={1}><Text color={ACCENT}>{spin} </Text><Text color={ACCENT}>{live.status || '思考中'}…</Text><Text dimColor>  ({secs} · Esc 中断)</Text></Box>}
      </Box>
    )
  }

  // ───────── 输入框 ─────────
  const Prompt = ({ cols, busy, version }: { cols: number; busy: boolean; version: number }) => {
    const [e, setE] = useState(ed.empty())
    const [sel, setSel] = useState(0)
    const hist = useRef<string[]>(engine.recentQuestions())
    const hi = useRef(hist.current.length)
    const draft = useRef('')
    const lastCtrlC = useRef(0)
    const [hint, setHint] = useState('')
    void version

    const matches = busy ? [] : matchSlash(e.text)
    const popup = matches.length > 0
    useEffect(() => { setSel(0) }, [e.text])

    const set = (n: ed.Ed): void => { setE(n); setHint('') }
    const submit = useCallback((raw: string) => {
      const text = raw.trim()
      if (!text) return
      if (hist.current[hist.current.length - 1] !== text) hist.current.push(text)
      hi.current = hist.current.length
      setE(ed.empty())
      const sl = parseSlash(text)
      if (text.startsWith('/') && sl) { void engine.slash(sl.name, sl.arg); return }
      // 直接拖进来的文件：当作导入
      const toks = splitPaths(text, os.homedir())
      if (toks.length && toks.every(t => { try { return fs.statSync(path.resolve(t)).isFile() } catch { return false } })) { void engine.slash('import', text); return }
      if (!engine.aiReady) { engine.model.notice('还没有配置 AI：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写，再回来提问', 'warn'); engine.deps.changed(); return }
      engine.send(text)
    }, [])

    useInput((input, key) => {
      // 中断 / 退出
      if (key.ctrl && input === 'c') {
        if (engine.model.live.running) { engine.stop(); return }
        if (e.text) { set(ed.empty()); return }
        const now = Date.now()
        if (now - lastCtrlC.current < 2000) { bridge.exit(); return }
        lastCtrlC.current = now; setHint('再按一次 Ctrl+C 退出'); return
      }
      if (key.escape) {
        if (engine.model.live.running) { engine.stop(); return }
        if (e.text) set(ed.empty())
        return
      }
      if (busy) return
      if (key.ctrl && input === 'd') { if (!e.text) bridge.exit(); return }
      if (key.return) {
        if (key.meta || key.shift) { set(ed.insert(e, '\n')); return }
        if (e.text.endsWith('\\') && e.cur === [...e.text].length) { set({ text: e.text.slice(0, -1) + '\n', cur: e.cur }); return }
        if (popup) {
          const c = matches[Math.min(sel, matches.length - 1)]
          if (c.args) { set(ed.fromText(`/${c.name} `)); return }
          setE(ed.empty()); void engine.slash(c.name, ''); return
        }
        submit(e.text); return
      }
      if (key.tab) { if (popup) { const c = matches[Math.min(sel, matches.length - 1)]; set(ed.fromText(`/${c.name}${c.args ? ' ' : ''}`)) } return }
      if (key.upArrow) {
        if (popup) { setSel(s => (s + matches.length - 1) % matches.length); return }
        const u = ed.up(e)
        if (u) { set(u); return }
        if (hi.current > 0) { if (hi.current === hist.current.length) draft.current = e.text; hi.current--; set(ed.fromText(hist.current[hi.current])) }
        return
      }
      if (key.downArrow) {
        if (popup) { setSel(s => (s + 1) % matches.length); return }
        const d = ed.down(e)
        if (d) { set(d); return }
        if (hi.current < hist.current.length) { hi.current++; set(ed.fromText(hi.current === hist.current.length ? draft.current : hist.current[hi.current])) }
        return
      }
      if (key.leftArrow) { set(ed.left(e)); return }
      if (key.rightArrow) { set(ed.right(e)); return }
      if (key.home || (key.ctrl && input === 'a')) { set(ed.lineStart(e)); return }
      if (key.end || (key.ctrl && input === 'e')) { set(ed.lineEnd(e)); return }
      if (key.ctrl && input === 'u') { set(ed.killToStart(e)); return }
      if (key.ctrl && input === 'k') { set(ed.killToEnd(e)); return }
      if (key.ctrl && input === 'w') { set(ed.deleteWord(e)); return }
      if (key.ctrl && input === 'j') { set(ed.insert(e, '\n')); return }
      if (key.backspace || key.delete) { set(ed.backspace(e)); return }
      if (input && !key.ctrl && !key.meta) set(ed.insert(e, input))
    })
    usePaste(t => { if (!busy) set(ed.insert(e, t)) })

    const view = ed.viewLines(e)
    const m = engine.model
    const usage = fmtUsage(m.totalUsage(), engine.priced)
    const wide = cols >= 72
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={busy ? undefined : ACCENT} borderDimColor={busy} paddingX={1} width={Math.min(cols, 96)}>
          <Text color={busy ? undefined : ACCENT} bold>❯ </Text>
          <Box flexDirection="column" flexShrink={1}>
            {e.text === '' && !busy
              ? <Text><Text inverse> </Text><Text dimColor>输入问题，或输入 / 查看命令</Text></Text>
              : busy && e.text === ''
                ? <Text dimColor>{m.live.running ? '助手正在工作…… Esc 中断' : '请稍等……'}</Text>
                : view.map((l, i) => 'plain' in l ? <Text key={i}>{l.plain || ' '}</Text> : <Text key={i}>{l.before}<Text inverse>{l.at}</Text>{l.after}</Text>)}
          </Box>
        </Box>
        {popup && (
          <Box flexDirection="column" paddingLeft={2}>
            {matches.slice(0, 8).map((c, i) => {
              const on = i === Math.min(sel, matches.length - 1)
              const left = `/${c.name}${c.args ? ' ' + c.args : ''}`
              return (
                <Text key={c.name} color={on ? ACCENT : undefined} bold={on} wrap="truncate-end">
                  {on ? '❯ ' : '  '}{left}{' '.repeat(Math.max(2, 18 - textWidth(left)))}<Text dimColor={!on}>{clipWidth(c.desc, Math.max(10, cols - 26))}</Text>
                </Text>
              )
            })}
            {matches.length > 8 ? <Text dimColor>  ……还有 {matches.length - 8} 个，继续输入缩小范围</Text> : null}
          </Box>
        )}
        <Box paddingLeft={2}>
          {hint
            ? <Text color={WARN}>{hint}</Text>
            : (
              <Text dimColor wrap="truncate-end">
                <Text color={ACCENT}>{engine.roleLabel}</Text>
                {`  ·  ${MODE_LABEL[engine.mode]}`}
                {wide ? `  ·  ${engine.aiReady ? engine.effectiveModel : '未配置 AI'}` : ''}
                {`  ·  ${usage}`}
              </Text>
            )}
        </Box>
      </Box>
    )
  }

  // ───────── 整体 ─────────
  const App = () => {
    const cols = useCols()
    const [, force] = useReducer((x: number) => x + 1, 0)
    const [choice, setChoice] = useState<{ title: string; options: Array<Choice<any>>; resolve: (v: any) => void } | null>(null)
    const [progress, setProgress] = useState<string | null>(null)
    const m = engine.model
    const tickBusy = useTick(progress !== null)

    useEffect(() => {
      const un = m.subscribe(() => force())
      bridge.choose = (title, options) => new Promise(resolve => setChoice({ title, options, resolve }))
      bridge.progress = setProgress
      return () => { un(); bridge.choose = null; bridge.progress = null }
    }, [])

    const live = m.live
    const busy = live.running || engine.busy || !!choice || !!live.pending
    return (
      <>
        <Static key={m.epoch} items={m.items}>{item => <ItemView key={item.id} item={item} cols={cols} />}</Static>
        <LiveView cols={cols} version={m.getVersion()} />
        {progress !== null && <Box marginTop={1}><Text color={ACCENT}>{SPIN[tickBusy % SPIN.length]} {progress}</Text></Box>}
        {live.pending
          ? <Box marginTop={1}><PendingView p={live.pending} cols={cols} /></Box>
          : choice
            ? (
              <Box marginTop={1}>
                <Select
                  cols={cols} title={choice.title} options={choice.options.map(x => ({ label: x.label, hint: x.hint }))}
                  onPick={i => { const c = choice; setChoice(null); c.resolve(i === null ? null : c.options[i].value) }}
                />
              </Box>
            )
            : <Box marginTop={1}><Prompt cols={cols} busy={busy} version={m.getVersion()} /></Box>}
      </>
    )
  }
  return App
}
