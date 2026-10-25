// 同比分类规则的边界：恰好 20 个百分点、样本 4/5 份。期望值是手算的。
import assert from 'node:assert/strict'
import { classifyChange, deltaPoints, limitedSides } from '../../src/main/stats/compare-math.ts'

// [目标出现份数, 目标总份数, 基线出现份数, 基线总份数, 期望, 说明]
const cases = [
  [3, 5, 2, 5, 'up', '60% − 40% = 恰好 +20（浮点相减得 0.19999999999999996）'],
  [1, 5, 2, 5, 'down', '20% − 40% = 恰好 −20'],
  [7, 10, 5, 10, 'up', '70% − 50% = +20'],
  [3, 10, 5, 10, 'down', '30% − 50% = −20'],
  [49, 100, 30, 100, null, '+19 不够'],
  [50, 100, 30, 100, 'up', '+20 够'],
  [51, 100, 30, 100, 'up', '+21'],
  [2, 5, 2, 5, null, '持平'],
  [3, 5, 3, 5, null, '持平'],
  [2, 4, 1, 4, 'up', '50% − 25% = +25'],
  [3, 6, 2, 5, null, '50% − 40% = +10'],
  [1, 3, 0, 4, 'added', '基线从未出现 → 新增（不管升了多少）'],
  [1, 20, 0, 3, 'added', '再少也是新增'],
  [0, 5, 3, 5, 'removed', '目标未出现 → 消失'],
  [0, 5, 1, 50, 'removed', '基线只有 2% 也算消失'],
  [0, 5, 0, 5, null, '两边都没有'],
  [5, 5, 4, 5, 'up', '100% − 80% = +20'],
  [4, 5, 5, 5, 'down', '80% − 100% = −20'],
  [1, 5, 5, 5, 'down', '20% − 100%'],
  [4, 0, 2, 5, null, '目标没有卷子，无法比较'],
  [4, 5, 2, 0, null, '基线没有卷子，无法比较']
]
for (const [aT, nT, aB, nB, want, why] of cases) assert.equal(classifyChange(aT, nT, aB, nB), want, `${aT}/${nT} vs ${aB}/${nB}：${why}`)

assert.equal(deltaPoints(3, 5, 2, 5), 20)
assert.equal(deltaPoints(1, 5, 2, 5), -20)
assert.equal(deltaPoints(1, 3, 1, 4), 8.3, '33.33% − 25% = 8.3')
assert.equal(deltaPoints(1, 0, 1, 4), 0)

assert.deepEqual(limitedSides(4, 5), ['target'])
assert.deepEqual(limitedSides(5, 4), ['base'])
assert.deepEqual(limitedSides(5, 5), [])
assert.deepEqual(limitedSides(1, 4), ['target', 'base'])
assert.deepEqual(limitedSides(0, 100), ['target'])

console.log(`stats-compare-math.test ✓ ${cases.length} 个边界用例`)
