/** 发往外部前的个人信息检测：手机号、身份证号、像人名的列表。只做提示，不拦截。 */
export interface PrivacyHit { phone: boolean; idCard: boolean; names: boolean; any: boolean }

const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
const nameLike = (t: string): boolean => /^[一-龥]{2,3}$/.test(t) && SURNAMES.includes(t[0])

export function detectPersonalInfo(text: string): PrivacyHit {
  const phone = /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)
  const idCard = /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/.test(text)
  let names = false
  const lines = text.split('\n')
  for (const line of lines) {
    const tokens = line.split(/[\s、，,；;|｜/]+/).map(s => s.replace(/[*_`#>\-\d.（）()]/g, '')).filter(Boolean)
    let run = 0
    for (const t of tokens) { run = nameLike(t) ? run + 1 : 0; if (run >= 3) { names = true; break } }
    if (names) break
  }
  // 竖排名单：连续 3 行，每行（去掉序号和符号后）就是一个人名
  if (!names) {
    let run = 0
    for (const line of lines) {
      const t = line.replace(/^[\s>\-*·•\d.、)）]+/, '').replace(/[*_`\s]/g, '')
      run = nameLike(t) ? run + 1 : 0
      if (run >= 3) { names = true; break }
    }
  }
  return { phone, idCard, names, any: phone || idCard || names }
}

export function privacyWarning(text: string): string | undefined {
  const h = detectPersonalInfo(text)
  if (!h.any) return undefined
  const what = [h.phone && '手机号', h.idCard && '身份证号', h.names && '姓名名单'].filter(Boolean).join('、')
  return `内容可能包含个人信息（${what}），请确认可以发到外部`
}
