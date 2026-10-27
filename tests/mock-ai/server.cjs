// 本地 OpenAI 兼容 mock 服务：POST /v1/chat/completions。
//  - 按请求里的「文件名 / 批次页码 / 是否带图」返回 canned.cjs 里的 P1 标准答案（文本版、视觉版）
//  - 可注入故障：空 content、非法 JSON、结构不符、429、5xx、401、超时（挂起）、被截断（finish_reason=length；{type:'length', times:N}：P1/P2/P3 都认，times=1 是「先写不完、加大上限后成功」，times=2 是「两次都写不完」）
//  - 推理模型：mock.reasoning = { chars, delayMs }：每次应答先流出 reasoning_content（思考）再流出正文，usage 里带 reasoning_tokens
//  - 记录每次请求（鉴权头、system/user 文本、图片数、并发数），供 E2E 断言
// 用法：const mock = await startMock({ apiKey: 'sk-mock' }); mock.baseUrl; mock.script([{ type: 'empty', times: 2 }]); await mock.stop()
const http = require('node:http')
const { build } = require('./canned.cjs')
const p2 = require('./p2.cjs')
const p3 = require('./p3.cjs')
const sleepMs = ms => new Promise(r => setTimeout(r, ms))

/** 从 data URL 里读出图片尺寸（PNG 看 IHDR，JPEG 找 SOF 段），E2E 用它核对「发给模型的图已缩小」 */
function imageDims(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  const b = Buffer.from(m[2], 'base64')
  if (m[1] === 'png') return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const mk = b[i + 1]
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { type: 'jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), bytes: b.length }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return { type: 'jpeg', w: 0, h: 0, bytes: b.length }
}

function textOf(content) {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text').map(p => p.text).join('\n')
}

async function startMock(opts = {}) {
  const apiKey = opts.apiKey ?? 'sk-mock-key'
  const state = {
    apiKey,
    requests: [],
    queue: [],            // 故障脚本
    delayMs: 0,           // 正常响应前的延迟（并发测试用）
    inflight: 0,
    maxInflight: 0,
    seenSystems: new Set(),
    quirks: {}
  }
  const sockets = new Set()

  // only: 'p1' | 'p2' | 'p3' 限定故障只作用于哪类请求（不写则都作用）
  function takeDirective(fileName, kind) {
    for (const d of state.queue) {
      if (d.times > 0 && (!d.file || fileName.includes(d.file)) && (!d.only || d.only === kind)) { d.times--; return d }
    }
    return null
  }

  function usageFor(sys, user, completion, stream) {
    const promptTokens = Math.ceil((sys.length + user.length) / 1.6)
    const cached = state.seenSystems.has(sys) ? Math.ceil(sys.length / 1.6) : 0
    state.seenSystems.add(sys)
    return { prompt_tokens: promptTokens, completion_tokens: Math.ceil(completion.length / 1.6), total_tokens: promptTokens + Math.ceil(completion.length / 1.6), prompt_cache_hit_tokens: cached, prompt_cache_miss_tokens: promptTokens - cached }
  }

  async function reply(res, body, stream, finish = 'stop', status = 200, extraHeaders = {}, opts = {}) {
    const content = body.content
    const think = state.reasoning && state.reasoning.chars > 0 ? '思'.repeat(state.reasoning.chars) : ''
    if (think) body.usage = { ...body.usage, completion_tokens_details: { reasoning_tokens: Math.ceil(think.length / 1.6) } }
    if (!stream) {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
      res.end(JSON.stringify({
        id: 'mock-' + Date.now(), object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content, ...(think ? { reasoning_content: think } : {}) }, finish_reason: finish }], usage: body.usage
      }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    // 推理模型：先流出思考（reasoning_content），再流出正文
    if (think) {
      for (let i = 0; i < think.length; i += 40) {
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { reasoning_content: think.slice(i, i + 40) }, finish_reason: null }] })}\n\n`)
        if (state.reasoning.delayMs) await sleepMs(state.reasoning.delayMs)
      }
    }
    const piece = opts.pieceChars ?? Math.max(1, Math.ceil(content.length / 8))
    let sent = 0
    for (let i = 0; i < content.length; i += piece) {
      if (opts.cutAfter !== undefined && sent >= opts.cutAfter) { await sleepMs(30); res.socket.destroy(); return }   // 中途断流
      if (opts.eofAfter !== undefined && sent >= opts.eofAfter) { res.end(); return }   // 「干净」的提前收尾：正常关闭连接，但没有 finish_reason 也没有 [DONE]（网关/代理超时常见）
      if (opts.stallAfter !== undefined && sent >= opts.stallAfter) { await sleepMs(opts.stallMs ?? 60000); return }  // 发了几段后不再有数据
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: content.slice(i, i + piece) }, finish_reason: null }] })}\n\n`)
      sent++
      if (opts.chunkDelayMs) await sleepMs(opts.chunkDelayMs)
    }
    // 最后一行没有结尾换行（网关/代理偶有）：内容照常发完，然后只发 `data: [DONE]`、不带换行就关连接
    if (opts.noFinalNewline) { res.end('data: [DONE]'); return }
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage: body.usage })}\n\n`)
    res.end('data: [DONE]\n\n')
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', async () => {
      state.inflight++
      state.maxInflight = Math.max(state.maxInflight, state.inflight)
      const done = () => { state.inflight-- }
      res.on('close', done)
      try {
        const auth = req.headers.authorization || ''
        let body
        try { body = JSON.parse(raw) } catch { res.writeHead(400); res.end('bad json'); return }
        const sys = textOf(body.messages.find(m => m.role === 'system')?.content ?? '')
        const userMsgs = body.messages.filter(m => m.role === 'user')
        const firstUser = userMsgs[0]
        const user = textOf(firstUser?.content ?? '')
        const images = Array.isArray(firstUser?.content) ? firstUser.content.filter(p => p.type === 'image_url').length : 0
        const fileName = /文件名：(.+)/.exec(user)?.[1]?.trim() ?? ''
        const batchLine = /本批信息：(.+)/.exec(user)?.[1] ?? ''
        const range = /第 (\d+)(?:–(\d+))? 页/.exec(batchLine)
        const pages = range ? Array.from({ length: Number(range[2] ?? range[1]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i) : [1]
        const prefix = /材料 id 前缀：(b\d+)/.exec(user)?.[1] ?? 'b1'
        const isP1 = /JSON/.test(sys) && /知识点树/.test(user)
        const isP2 = p2.isP2(sys, user)
        const isP3 = p3.isP3(sys, user)
        // 看板抽屉里「只讲这一个考点」的分析（p2_kp）
        const isKp = /只围绕输入里给出的这一个考点/.test(sys) && /【这一个考点】/.test(user)
        const rec = {
          at: Date.now(), auth, model: body.model, stream: !!body.stream, jsonMode: body.response_format?.type === 'json_object',
          maxTokens: body.max_tokens, system: sys, user, images, messageCount: body.messages.length, fileName, batchLine, pages, prefix,
          isP1, isP2, isP3, retryFeedback: userMsgs.length > 1 ? textOf(userMsgs[userMsgs.length - 1].content) : '',
          hasPrevUnfinished: /未完成的题/.test(user), imageDims: Array.isArray(firstUser?.content) ? firstUser.content.filter(p => p.type === 'image_url').map(p => imageDims(p.image_url.url)) : [], imageUrls: Array.isArray(firstUser?.content) ? firstUser.content.filter(p => p.type === 'image_url').map(p => p.image_url.url.slice(0, 30)) : [],
          body: raw.length,
          directive: null
        }
        state.requests.push(rec)

        if (auth !== `Bearer ${state.apiKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Authentication Fails, invalid api key' } }))
          return
        }

        const d = takeDirective(fileName, isP3 ? 'p3' : isP2 || isKp ? 'p2' : 'p1')
        if (d) rec.directive = d.type
        if (d && d.type === 'hang') { await new Promise(r => setTimeout(r, d.ms ?? 60000)); return }
        if (d && d.type === '429') { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(d.retryAfter ?? 1) }); res.end(JSON.stringify({ error: { message: 'rate limit' } })); return }
        if (d && (d.type === '500' || d.type === '503')) { res.writeHead(Number(d.type), { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'server error' } })); return }
        // 307 重定向到别的主机：用来验证客户端不跟随重定向（Authorization 不会被带过去）
        if (d && d.type === 'redirect') { res.writeHead(307, { Location: d.to }); res.end(); return }
        // 400 里回显鉴权头里的密钥：验证展示给用户/写库的错误文案已脱敏
        if (d && d.type === '400echo') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.replace(/^Bearer /, '')}. You can find your API key at https://platform.example.com` } }))
          return
        }
        if (d && d.type === 'bad_response_format' && body.response_format) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: "'response_format' is not supported by this model" } }))
          return
        }
        if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs))

        const usageOf = (c) => usageFor(sys, user, c, body.stream)
        if (d && d.type === 'empty') return reply(res, { model: body.model, content: '', usage: usageOf('') }, body.stream)
        if (d && d.type === 'badjson') {
          const c = '{"meta": {"title": "2025-2026学年", "grade": 4, "questions": [ {"no": "1", "stem": "Look'
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream)
        }
        if (d && d.type === 'schema') {
          const c = JSON.stringify({ meta: {}, sections: [], materials: [], questions: [{ no: '1', section: '一', stem: 'x', kp_main: 'PH', difficulty: 9, page: 1, anchor: 'x', anchor_ref: '1-01' }], notes: [] })
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream)
        }
        if (d && (d.type === 'truncated' || (d.type === 'length' && isP1))) {
          const c = '{"meta":{"title":"2025-2026学年第二学期四年级英语期末试卷","grade":4},"sections":[{"no":"一","title":"选出画线部分","qtype":"PH_DIFF"'
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream, 'length')
        }

        // P2 年度变化分析：按收到的提示词里的表格写一篇 Markdown，流式分段发出
        if (isP2) {
          let c = p2.build(user, { ...state.quirks.p2 })
          const lenCut = !!(d && d.type === 'length')
          if (lenCut) c = c.slice(0, Math.max(10, Math.floor(c.length / 2)))   // 写不完：只发出一半，finish_reason=length
          const opts = { pieceChars: 24, chunkDelayMs: state.p2DelayMs || 0 }
          if (d && d.type === 'p2_cut') opts.cutAfter = d.after ?? 3
          if (d && d.type === 'p2_nonl') opts.noFinalNewline = true
          if (d && d.type === 'p2_eof') opts.eofAfter = d.after ?? 3
          if (d && d.type === 'p2_stall') { opts.stallAfter = d.after ?? 3; opts.stallMs = d.ms ?? 60000 }
          if (d && d.type === 'p2_slow') opts.chunkDelayMs = d.delayMs ?? 120
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream, lenCut ? 'length' : 'stop', 200, {}, opts)
        }

        // 单个考点分析：四行短文，只讲输入里的这一个考点（名称 / 数据 / 样本题取自输入）
        if (isKp) {
          state.kpRequests = state.kpRequests || []
          state.kpRequests.push({ system: sys, user, maxTokens: body.max_tokens })
          const name = /【这一个考点】(.*)/.exec(user)?.[1]?.trim() ?? '这个考点'
          const data = /【这一个考点】.*\n(.*)/.exec(user)?.[1]?.trim() ?? ''
          const cite = /\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/.exec(user)?.[0] ?? ''
          const c = [`- **考什么**：${name}。`, `- **今年的情况**：${data}`, '- **容易错在哪**：这几份卷子里没有 AI 估计的易错题。', `- **课上怎么讲**：先读题再选，${cite ? '可以用原卷例题 ' + cite : '用原卷里的题当例子'}。`].join('\n')
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream, 'stop', 200, {}, { pieceChars: 24, chunkDelayMs: state.p3DelayMs || 0 })
        }

        // P3 考情分析报告：流式分段发出；故障指令沿用 p2_* 这组名字（对任何流式分析都生效：p2_cut / p2_eof / p2_nonl / p2_stall / p2_slow）
        if (isP3) {
          let c = p3.build(user, { ...state.quirks.p3 }, sys)
          const lenCut = !!(d && d.type === 'length')
          if (lenCut) c = c.slice(0, Math.max(10, Math.floor(c.length / 2)))
          const opts = { pieceChars: 24, chunkDelayMs: state.p3DelayMs || 0 }
          if (d && d.type === 'p2_cut') opts.cutAfter = d.after ?? 3
          if (d && d.type === 'p2_nonl') opts.noFinalNewline = true
          if (d && d.type === 'p2_eof') opts.eofAfter = d.after ?? 3
          if (d && d.type === 'p2_stall') { opts.stallAfter = d.after ?? 3; opts.stallMs = d.ms ?? 60000 }
          if (d && d.type === 'p2_slow') opts.chunkDelayMs = d.delayMs ?? 120
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream, lenCut ? 'length' : 'stop', 200, {}, opts)
        }

        // 正常响应
        const fenced = !!(d && d.type === 'fenced')
        if (isP1) {
          const mode = images > 0 ? 'vision' : 'text'
          let name = fileName.replace(/\.[^.]+$/, '')
          const out = build({ file: fileName, mode, pages, prefix, splitLast: !!state.splitLast, visionFile: name, quirks: { ...state.quirks } })
          if (!out) {
            const c = JSON.stringify({ meta: {}, sections: [], materials: [], questions: [], notes: ['mock：没有这份试卷的 canned 数据'] })
            return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream)
          }
          // 真实模型偶尔会把 JSON 包在 ```json 围栏里（提示词已禁止，程序要能容忍）
          const c = fenced ? '```json\n' + JSON.stringify(out) + '\n```' : JSON.stringify(out)
          return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream)
        }
        // 其它请求（连接测试等）
        const c = '{"ok":true}'
        return reply(res, { model: body.model, content: c, usage: usageOf(c) }, body.stream)
      } catch (e) {
        console.error('[mock-ai] 处理请求出错', e)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      }
    })
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(r => server.listen(opts.port ?? 0, '127.0.0.1', r))
  const port = server.address().port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() { return state.requests },
    get p1Requests() { return state.requests.filter(r => r.isP1) },
    get maxInflight() { return state.maxInflight },
    get apiKey() { return state.apiKey },
    set apiKey(v) { state.apiKey = v },
    set delayMs(v) { state.delayMs = v },
    set splitLast(v) { state.splitLast = v },
    /** P2 正常应答每段之间的延迟（毫秒）；0 = 不延迟 */
    set p2DelayMs(v) { state.p2DelayMs = v },
    /** P3 正常应答每段之间的延迟（毫秒） */
    set p3DelayMs(v) { state.p3DelayMs = v },
    /** 推理模型：{ chars, delayMs } 或 null；应答先流出 reasoning_content 再流出正文 */
    set reasoning(v) { state.reasoning = v },
    get p2Requests() { return state.requests.filter(r => r.isP2) },
    get p3Requests() { return state.requests.filter(r => r.isP3) },
    get kpRequests() { return state.kpRequests || [] },
    /** canned 响应的「真实模型会犯的错」：{ noFlag, dropContinued, typo, badPage } */
    set quirks(v) { state.quirks = v },
    /** 追加故障脚本：{ type, times, file? }；按顺序、按文件名子串匹配消费 */
    script(list) { for (const d of list) state.queue.push({ times: 1, ...d }) },
    clearScript() { state.queue.length = 0 },
    reset() { state.requests.length = 0; state.queue.length = 0; state.maxInflight = 0; state.delayMs = 0; state.splitLast = false; state.quirks = {}; state.p2DelayMs = 0; state.p3DelayMs = 0; state.reasoning = null; state.seenSystems.clear() },
    resetStats() { state.requests.length = 0; state.maxInflight = 0 },
    async stop() {
      for (const s of sockets) s.destroy()
      await new Promise(r => server.close(r))
    }
  }
}

module.exports = { startMock }

if (require.main === module) {
  startMock({ port: Number(process.env.PORT) || 18080, apiKey: process.env.MOCK_KEY || 'sk-mock-key' }).then(m => {
    console.log(`mock AI 服务已启动：${m.baseUrl}  （Ctrl+C 退出）`)
  })
}
