/**
 * AI 调用出错时的原因诊断（纯函数，不依赖 electron）：在 AiError 之上再包一层，
 * 给出一句主因 + 按可能性排序的 1–4 条可能原因（各带「怎么办」）+ 服务商原话。
 * 不改 client.ts / friendly.ts 里已有的错误映射。detail 已在 statusError 里脱敏，这里再保险地抹一遍 sk- 开头的串。
 */

export interface ErrorLike { code?: string; status?: number | null; detail?: string; message?: string }

export interface DiagnoseCtx {
  /** 刚查过的余额；amount 为 null 表示不限额度 */
  balance?: { amount: number | null; currency: string; text: string } | null
  /** 服务商是否支持查余额（支持但没查到结果也要说明） */
  balanceSupported?: boolean
  task?: string
  model?: string
  reasoning?: boolean
}

export interface Reason { text: string; fix: string }
export interface Diagnosis { cause: string; reasons: Reason[]; raw: string; balanceRelated: boolean }

const QUOTA_RE = /insufficient|balance|quota|credit|arrear|exhaust|not enough|out of (funds|credit)|billing|欠费|余额|额度|配额|充值|用完|耗尽/i
const RATE_RE = /rate.?limit|too many|tpm|rpm|throttl|frequen|请求过于频繁|太频繁|限流|请求频率/i
const CONC_RE = /concurren|并发|parallel/i
const BUSY_RE = /overload|busy|capacity|繁忙|排队|过载|queue|unavailable|try again later/i
const FILTER_RE = /content[_ ]?(filter|policy|management)|sensitive|moderation|safety|审核|敏感|违规|不安全|inappropriate/i
const FORMAT_RE = /json|格式|解析|schema|结构/i

const scrub = (s: string) => s.replace(/(sk|tk|key)-[A-Za-z0-9_-]{8,}/g, '$1-***').replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')

export function isBalanceRelated(e: ErrorLike): boolean {
  const d = e.detail ?? ''
  if (e.status === 402) return true
  if (e.status === 429 || e.status === 400 || e.status === 403) return QUOTA_RE.test(d) && !RATE_RE.test(d.replace(/quota/gi, ''))
  return e.status ? QUOTA_RE.test(d) && e.status !== 401 && e.status !== 404 && e.status < 500 : false
}

export function rawLine(e: ErrorLike): string {
  const parts = [e.status ? `HTTP ${e.status}` : e.code ? `错误类型 ${e.code}` : '']
  const detail = scrub((e.detail ?? '').trim()).slice(0, 300)
  parts.push(detail ? `服务商原话：${detail}` : `信息：${scrub((e.message ?? '').trim()).slice(0, 200) || '无'}`)
  return parts.filter(Boolean).join(' · ')
}

const balanceReason = (ctx: DiagnoseCtx): Reason => ({
  text: ctx.balance && ctx.balance.amount !== null && ctx.balance.amount <= 0 ? `账户余额或额度已用完（当前${ctx.balance.text.startsWith('额度') ? '' : '余额 '}${ctx.balance.text}）` : '账户余额或额度不足',
  fix: '到服务商控制台充值，或联系管理员给你的密钥增加额度，然后点「重试」'
})

export function diagnose(e: ErrorLike, ctx: DiagnoseCtx = {}): Diagnosis {
  const d = e.detail ?? ''
  const raw = rawLine(e)
  const balanceKnownEmpty = !!ctx.balance && ctx.balance.amount !== null && ctx.balance.amount <= 0
  const quota = isBalanceRelated(e) || (balanceKnownEmpty && e.code !== 'aborted')
  const out = (cause: string, reasons: Reason[]): Diagnosis => ({ cause, reasons: reasons.slice(0, 4), raw, balanceRelated: quota })
  const model = ctx.model ? `（${ctx.model}）` : ''

  // 余额 / 额度不足
  if (e.status === 402 || e.code === 'balance' || (quota && e.status !== 429 && e.status !== 401 && e.status !== 404 && !(e.status && e.status >= 500))) {
    return out(balanceKnownEmpty ? `账户余额已用完${ctx.balance ? `（当前 ${ctx.balance.text}）` : ''}` : '账户余额或额度不足', [
      balanceReason(ctx),
      { text: '如果刚充值过，可能还没到账', fix: '等一两分钟再点「重试」；仍不行就刷新余额确认' },
      { text: '用的不是你以为的那把密钥（别的账号、额度更小的密钥）', fix: '在「设置 → AI 服务」确认密钥是充值过的那个账号的' }
    ])
  }

  switch (e.code) {
    case 'auth':
      return out('API Key 无效或已过期', [
        { text: '密钥复制不完整，或前后多了空格', fix: '重新复制整段密钥，粘贴后保存' },
        { text: '密钥已被删除、停用或过期', fix: '到服务商控制台看密钥是否还在，必要时新建一个' },
        { text: '密钥和所选服务商 / 地址不是一家的', fix: '核对「设置 → AI 服务」里的服务商和 Base URL' }
      ])
    case 'forbidden':
      return out(`这个密钥没有权限使用这个模型${model}`, [
        { text: '密钥没有开通该模型', fix: '到服务商控制台开通该模型，或换一个有权限的模型' },
        ...(FILTER_RE.test(d) ? [{ text: '内容被服务商的安全审核拦截', fix: '换一个范围再试，或联系服务商' }] : []),
        { text: '公司网关限制了这把密钥可用的模型', fix: '联系管理员确认你的密钥能用哪些模型' },
        ...(quota ? [balanceReason(ctx)] : [])
      ])
    case 'not_found':
      return out(`找不到模型或接口${model}`, [
        { text: '模型名写错或该模型已下线', fix: '到服务商控制台复制最新的模型名，填进「设置 → AI 服务」' },
        { text: 'Base URL 写错（多写或少写了 /v1 等）', fix: '按服务商文档核对 Base URL，用「测试全部」确认' },
        { text: '中转平台没有上架这个模型', fix: '联系平台管理员，或换一个平台上有的模型' }
      ])
    case 'rate_limit': {
      const q = QUOTA_RE.test(d)
      const conc = CONC_RE.test(d)
      const rate = RATE_RE.test(d)
      const reasons: Reason[] = []
      if (q) reasons.push(balanceReason(ctx))
      if (conc) reasons.push({ text: '同时进行的请求太多，超过了并发上限', fix: '在「设置 → AI 服务」把同时解析的份数调小，等当前任务做完再试' })
      if (rate || (!q && !conc)) reasons.push({ text: '请求太频繁，或服务商正在排队拥堵', fix: '等一会儿再点「重试」；经常出现就把并发调小' })
      if (!q) reasons.push({ text: '中转平台常用 429 表示额度用完', fix: '查看账户余额 / 额度，必要时充值或联系平台管理员' })
      if (!conc) reasons.push({ text: '多人共用同一把密钥，被别人占满了', fix: '错开时间，或向管理员要自己的密钥' })
      return out(q ? '额度可能已用完（服务商返回 429）' : conc ? '并发请求超过上限（429）' : '请求太频繁或服务商拥堵（429）', reasons)
    }
    case 'server': {
      const busy = BUSY_RE.test(d) || e.status === 503
      return out(busy ? '服务商现在过载或繁忙' : '服务商那边出了故障', [
        { text: busy ? '服务商高峰期排队、过载' : '服务商临时故障', fix: '过几分钟再点「重试」；已完成的部分会保留' },
        { text: '服务商返回的内容程序读不懂（网关出错）', fix: '换个时间再试；持续出现请联系服务商或平台管理员' },
        ...(e.status && e.status >= 500 ? [{ text: '公司网关或中转平台自身出问题', fix: '联系管理员查看网关状态' }] : [])
      ])
    }
    case 'network':
      return out('连不上 AI 服务（网络问题）', [
        { text: '电脑没联网，或网络不稳定', fix: '检查网络后点「重试」' },
        { text: '开了代理 / VPN，或公司网络拦截了该地址', fix: '关掉代理试试，或请网络管理员放行这个地址' },
        { text: 'Base URL 写错', fix: '核对「设置 → AI 服务」里的地址' }
      ])
    case 'timeout':
      return out(ctx.reasoning ? '模型思考太久，超时了' : '等了太久，服务商没有回应', [
        ...(ctx.reasoning ? [{ text: `模型${model}是会先思考的类型，一次要等很久`, fix: '换一个速度快的模型，或在高级设置里调大超时时间' }] : []),
        { text: '服务商繁忙，响应很慢', fix: '稍后再点「重试」' },
        { text: '网络慢或代理不稳', fix: '检查网络；必要时调大「设置 → AI 服务」里的超时时间' }
      ])
    case 'truncated':
      return out('AI 写到一半被截断了', [
        { text: '输出长度上限不够', fix: '在「设置 → AI 服务」里打开输出上限「自动」，或调大上限' },
        { text: '模型思考太多，占掉了输出额度', fix: '换一个不带深度思考的模型' },
        { text: '一次让 AI 处理的内容太多', fix: '把范围缩小一些再试' }
      ])
    case 'empty':
      return out('AI 没有返回内容', [
        ...(FILTER_RE.test(d) ? [{ text: '内容被服务商的安全审核拦截', fix: '换一个范围再试' }] : []),
        { text: '模型临时出错或返回了空回答', fix: '点「重试」' },
        { text: '输出额度被思考用完，没剩下正文', fix: '调大输出上限，或换不带深度思考的模型' }
      ])
    case 'bad_output':
      return out('AI 的回答格式不对，程序读不懂', [
        { text: '模型这次没按要求的格式回答（常见于输出被截短或夹杂说明文字）', fix: '点「重试」，一般第二次就好' },
        { text: '当前模型不太擅长按格式输出', fix: '换一个更强的模型' },
        { text: '输出长度上限不够，回答写到一半', fix: '在「设置 → AI 服务」把输出上限改成「自动」' }
      ])
    case 'aborted':
      return out('已取消', [])
    case 'bad_request': {
      if (FILTER_RE.test(d)) return out('内容被服务商的安全审核拦截', [{ text: '提交的内容触发了审核规则', fix: '换一个范围再试；仍然不行请联系服务商' }, { text: '模型自身的内容策略较严', fix: '换一个模型' }])
      if (/context|maximum|too long|token|长度|超出/i.test(d)) return out('一次发给模型的内容太长', [{ text: '超过了模型的上下文长度', fix: '缩小范围，或换上下文更长的模型' }, { text: '输出上限设得比模型允许的还大', fix: '在「设置 → AI 服务」把输出上限改成「自动」' }])
      return out(`服务商拒绝了这次请求${e.status ? `（HTTP ${e.status}）` : ''}`, [
        { text: '请求参数服务商不支持（例如输出上限、JSON 模式）', fix: '把输出上限改成「自动」，或换一个模型' },
        { text: '模型名与服务商不匹配', fix: '核对模型名，用「测试全部」确认' },
        { text: '详情见下方“服务商原话”', fix: '把原话发给管理员排查' }
      ])
    }
  }
  if (FORMAT_RE.test(e.message ?? '') || FORMAT_RE.test(d)) {
    return out('AI 的回答格式不对，程序读不懂', [
      { text: '模型这次没按要求的格式回答', fix: '点「重试」，一般第二次就好' },
      { text: '当前模型不太擅长按格式输出', fix: '换一个更强的模型' }
    ])
  }
  return out('AI 这次没有成功', [{ text: '原因不明', fix: '点「重试」；多次失败请把下方信息发给管理员' }])
}

/** 复制给管理员的文本：不含密钥 */
export function diagnosisText(g: Diagnosis, extra = ''): string {
  return [g.cause, ...g.reasons.map((r, i) => `${i + 1}. ${r.text} → ${r.fix}`), g.raw, extra].filter(Boolean).join('\n')
}
