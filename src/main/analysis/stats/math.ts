/**
 * 统计用的数学小工具（纯函数，不依赖任何库）：正态分布、t 分布、Wilson 置信区间。
 * 精度够老师做“差异是不是明显”的判断（p 值误差 < 1e-6），不追求科研级。
 */

/** 误差函数的互补函数（Numerical Recipes erfc，相对误差 < 1.2e-7） */
function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? r : 2 - r
}

/** 标准正态分布的累积概率 */
export function normCdf(z: number): number { return 0.5 * erfc(-z / Math.SQRT2) }

/** 标准正态分布的分位数（Acklam 近似，相对误差 ~1e-9） */
export function normQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) return -normQuantile(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += g[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300
  const qab = a + b, qap = a + 1, qam = a - 1
  let c = 1
  let d = 1 - qab * x / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 3e-12) break
  }
  return h
}

/** 正则化不完全贝塔函数 I_x(a,b) */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b
}

/** t 分布的双侧 p 值 */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0
  if (!(df > 0)) return NaN
  return Math.min(1, Math.max(0, betaInc(df / (df + t * t), df / 2, 0.5)))
}

/** z 的双侧 p 值 */
export function zTwoSidedP(z: number): number { return Math.min(1, Math.max(0, 2 * (1 - normCdf(Math.abs(z))))) }

/** 比例的 Wilson 置信区间（比普通正态近似在小样本、比例靠近 0/1 时可靠）。返回 0~1 的比例 */
export function wilson(x: number, n: number, confidence = 0.95): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 }
  const z = normQuantile(1 - (1 - confidence) / 2)
  const p = x / n
  const z2 = z * z
  const den = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / den
  const half = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

export const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1)
}
