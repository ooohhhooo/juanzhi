/**
 * 大字结论 <Headline>：一句中文结论，句中关键数字用 44px Source Sans 3 Bold。不要做成数字卡片。
 *
 * 用法：
 *   <Headline>今年四年级 <Headline.Num>72</Headline.Num> 道题，最该补的是 <Headline.Term>名词复数</Headline.Term> 和 <Headline.Term>time for / to</Headline.Term></Headline>
 */
import React from 'react'

function Num({ children }: { children: React.ReactNode }) {
  return <span className="ewb-headline__num">{children}</span>
}
/** 句中的考点名：词头蓝加粗 */
function Term({ children }: { children: React.ReactNode }) {
  return <span className="ewb-headline__term">{children}</span>
}

function Headline({ children, as: Tag = 'h1', ...rest }: { children: React.ReactNode; as?: 'h1' | 'h2'; 'data-testid'?: string }) {
  return <Tag className="ewb-headline" data-testid={rest['data-testid']}>{children}</Tag>
}
Headline.Num = Num
Headline.Term = Term

export default Headline
