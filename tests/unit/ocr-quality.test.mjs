// 本机识别的质量判断与「每页走文本还是读图」的决定（M9 D1/D2）。直接加载 TS 源文件。
import assert from 'node:assert/strict'
import { ocrQuality, paperExpectsCjk, namesHaveCjk, relaxSparse, decidePage, textStats } from '../../src/main/pipeline/ocr-quality.ts'

const english = ['Look at the sheep.', 'How much is this skirt?', 'It is fifty yuan.', 'Is this the computer room?', 'Yes, it is.']
const chinese = ['一、选出画线部分读音不同的一项。', '二、单项选择。（每题2分，共20分）', '三、用所给词的适当形式填空。', '四、补全对话。']
// Windows 的 en-US 引擎读中文页：中文要么消失，要么变成乱码
const garbled = ['Ii ■ ◆ ☐ ☐ ��', '□ □ ��� ◇◇ �', '≈ ≈ ≈ ∞ ∞', 'Look at the sheep', '??? ### ~~~']

// ───────── ocrQuality 决策表 ─────────
{
  // zh 引擎正常页 → 不低
  const q = ocrQuality([...chinese, ...english], { lang: 'zh-Hans-CN', paperExpectsCjk: true })
  assert.equal(q.low, false, 'zh 引擎的正常页不低')
  assert.equal(q.why, 'ok')
  // en-US 引擎 + 这份卷子本应含中文 → 直接判 lang-mismatch，不用看文字（文字看起来再正常也一样）
  const m = ocrQuality(english, { lang: 'en-US', paperExpectsCjk: true })
  assert.equal(m.low, true); assert.equal(m.why, 'lang-mismatch')
  // en-US 引擎 + 没有任何中文证据（纯英文卷）→ 不下结论
  const e = ocrQuality(english, { lang: 'en-US', paperExpectsCjk: false })
  assert.equal(e.low, false, '纯英文卷用英文引擎没问题，不乱提示')
  // 乱码比例高
  const g = ocrQuality(garbled, { lang: 'zh-Hans-CN', paperExpectsCjk: true })
  assert.equal(g.low, true); assert.equal(g.why, 'garbled')
  // 空白页
  assert.equal(ocrQuality([], { paperExpectsCjk: false }).why, 'empty')
  assert.equal(ocrQuality(['  ', ''], { paperExpectsCjk: false }).low, true)
  // 行数 / 字数异常少
  const s = ocrQuality(['Hello', 'World'], { lang: 'zh-Hans-CN', paperExpectsCjk: false })
  assert.equal(s.low, true); assert.equal(s.why, 'sparse')
  // 置信度：有（macOS）才看；null（Windows 固定 0.8 不可信，调用方传 null）不看
  assert.equal(ocrQuality([...chinese, ...english], { paperExpectsCjk: true, conf: 0.4 }).why, 'low-conf')
  assert.equal(ocrQuality([...chinese, ...english], { paperExpectsCjk: true, conf: null }).low, false)
  assert.equal(ocrQuality([...chinese, ...english], { paperExpectsCjk: true, conf: 0.9 }).low, false)
}
{
  const st = textStats(['一二三abc', '。！'])
  assert.equal(st.chars, 8); assert.ok(Math.abs(st.cjk - 3 / 8) < 1e-9); assert.equal(st.lines, 2)
}

// ───────── 这份卷子本应含中文吗（只看页面证据；文件名里有中文只是弱证据）─────────
assert.equal(namesHaveCjk(['期末卷.pdf']), true)
assert.equal(namesHaveCjk(['final.pdf', '']), false)
assert.equal(paperExpectsCjk({ pageTexts: [{ texts: chinese, trustedForCjk: true }] }), true, '有页的中文占比够高')
assert.equal(paperExpectsCjk({ pageTexts: [{ texts: chinese, trustedForCjk: false }] }), false, '英文引擎读出的中文不可信，不当证据')
assert.equal(paperExpectsCjk({ pageTexts: [{ texts: english, trustedForCjk: true }] }), false, '纯英文卷没有证据')
{
  // 英文扫描件叫「2024海淀期末英语.pdf」+ en-US 引擎：正常的英文页不能因为文件名就判成 lang-mismatch
  const q = ocrQuality([...english, ...english], { lang: 'en-US', paperExpectsCjk: false, nameHasCjk: true })
  assert.equal(q.low, false, '只有文件名里有中文，不够')
  const c = decidePage({ textSource: 'ocr', hasImage: true, rowTexts: [...english, ...english], lang: 'en-US', conf: null }, { policy: 'auto', visionReady: true, expectsCjk: false, nameHasCjk: true })
  assert.equal(c.mode, 'text'); assert.equal(c.low, false)
  // 文件名有中文 + 别的坏信号（乱码多 / 太短）才判
  assert.equal(ocrQuality(garbled, { lang: 'en-US', paperExpectsCjk: false, nameHasCjk: true }).why, 'lang-mismatch')
  assert.equal(ocrQuality(['Hello', 'World'], { lang: 'en-US', paperExpectsCjk: false, nameHasCjk: true }).why, 'lang-mismatch')
}
{
  // 封面 / 答案页 / 最后一页本来就短：同一份卷子里有正常的页就不算
  const ok = ocrQuality([...chinese, ...english], { lang: 'zh-Hans-CN', paperExpectsCjk: true })
  const short = ocrQuality(['答案', 'A B C'], { lang: 'zh-Hans-CN', paperExpectsCjk: true })
  assert.equal(short.why, 'sparse')
  const r = relaxSparse([ok, short])
  assert.equal(r[1].low, false); assert.equal(r[0].low, false)
  assert.equal(relaxSparse([null, short])[1].low, false, 'PDF 文字层 / Word 的页算正常页')
  assert.equal(relaxSparse([short, short])[0].low, true, '整份都很短就还是低')
  const bad = ocrQuality(garbled, { lang: 'zh-Hans-CN', paperExpectsCjk: true })
  assert.equal(relaxSparse([ok, bad])[1].low, true, '乱码不放过')
}

// ───────── decidePage：三种读图策略 ─────────
const base = { textSource: 'ocr', hasImage: true, rowTexts: english, lang: 'en-US', conf: null }
const ctx = (o = {}) => ({ policy: 'auto', visionReady: true, expectsCjk: true, ...o })
{
  // Windows 的老毛病：en-US + 固定 0.8 置信度 + 中文卷 → auto 策略也要读图（以前永远不会）
  const c = decidePage(base, ctx())
  assert.equal(c.mode, 'vision'); assert.equal(c.reason, 'lang-mismatch'); assert.equal(c.low, true)
  // 没有可用的视觉模型：仍用本机文字，但记下「识别不完整」
  const n = decidePage(base, ctx({ visionReady: false }))
  assert.equal(n.mode, 'text'); assert.equal(n.reason, 'no-vision-model'); assert.equal(n.low, true)
  // never：从不读图
  const v = decidePage(base, ctx({ policy: 'never' }))
  assert.equal(v.mode, 'text'); assert.equal(v.reason, 'vision-never'); assert.equal(v.low, true)
  // images_always：质量再好也读图
  const good = { ...base, lang: 'zh-Hans-CN', rowTexts: [...chinese, ...english] }
  assert.equal(decidePage(good, ctx()).mode, 'text', 'auto：质量好的页不读图')
  assert.equal(decidePage(good, ctx()).reason, 'ocr-ok')
  const a = decidePage(good, ctx({ policy: 'images_always' }))
  assert.equal(a.mode, 'vision'); assert.equal(a.reason, 'policy-images-always'); assert.equal(a.low, false)
  // images_always 但没有视觉模型 → 退回文本，不报错
  assert.equal(decidePage(good, ctx({ policy: 'images_always', visionReady: false })).mode, 'text')
  // 没有页面图的页不能读图
  assert.equal(decidePage({ ...base, hasImage: false }, ctx()).mode, 'text')
}
{
  // PDF 文字层 / Word：不管策略，直接用文字（images_always 只管图片和扫描件）
  assert.equal(decidePage({ textSource: 'pdf-text', hasImage: true, rowTexts: english, lang: null, conf: null }, ctx({ policy: 'images_always' })).mode, 'text')
  assert.equal(decidePage({ textSource: 'docx', hasImage: true, rowTexts: english, lang: null, conf: null }, ctx({ policy: 'images_always' })).reason, 'docx-text')
  // 本机识别失败 / 没读出文字：有视觉模型读图，没有就跳过
  assert.equal(decidePage({ textSource: 'ocr_failed', hasImage: true, rowTexts: [], lang: null, conf: null }, ctx()).mode, 'vision')
  assert.equal(decidePage({ textSource: 'ocr_failed', hasImage: true, rowTexts: [], lang: null, conf: null }, ctx({ visionReady: false })).mode, 'skip')
  assert.equal(decidePage({ textSource: 'none', hasImage: true, rowTexts: [], lang: null, conf: null }, ctx()).reason, 'no-text')
}
{
  // macOS：有置信度。低于 0.55 → 读图（老行为保留）；正常 → 文本
  const mac = { textSource: 'ocr', hasImage: true, rowTexts: [...chinese, ...english], lang: null, conf: 0.4 }
  assert.equal(decidePage(mac, ctx({ expectsCjk: true })).reason, 'low-conf')
  assert.equal(decidePage({ ...mac, conf: 0.9 }, ctx()).mode, 'text')
  // 没有视觉模型时，只是置信度偏低不算「识别不完整」（mac 的置信度整体偏低），照用本机文字
  const noV = decidePage(mac, ctx({ visionReady: false }))
  assert.equal(noV.mode, 'text'); assert.equal(noV.reason, 'ocr-ok'); assert.equal(noV.low, false)
}
console.log('ocr-quality.test ✓')
