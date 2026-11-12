import assert from 'node:assert/strict'
import { navKeyForPath, tabGroupForPath, NAV_GROUPS } from '../../src/renderer/design/navGroups.ts'

for (const p of ['/', '/queue', '/review', '/review/12', '/paper/3']) assert.equal(navKeyForPath(p), '/', p)
for (const p of ['/overview', '/dashboard']) assert.equal(navKeyForPath(p), '/overview', p)
for (const p of ['/courses', '/courses/research']) assert.equal(navKeyForPath(p), '/courses', p)
for (const p of ['/assistant', '/report', '/datasets', '/settings']) assert.equal(navKeyForPath(p), p, p)
assert.equal(tabGroupForPath('/queue')?.key, '/')
assert.equal(tabGroupForPath('/dashboard')?.key, '/overview')
assert.equal(tabGroupForPath('/courses/research')?.key, '/courses')
assert.equal(tabGroupForPath('/review/12'), undefined)
assert.equal(tabGroupForPath('/paper/3'), undefined)
assert.equal(NAV_GROUPS.length, 3)
console.log('nav-groups ok')
