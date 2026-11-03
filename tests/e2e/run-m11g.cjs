// 助手设置里的 Skill 页签端到端：打开助手设置 → Skill 页签 → 新建 → 在「＋」菜单里看到并选中 → 导入含 SKILL.md 的文件夹 → 列表出现 → 删除。
// 用法：npm run test:e2e:m11g   （沙箱外运行）
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { check, waitFor, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L, stubOpen } = M

const SHOT = process.env.SKILL_SHOT || path.join(work, 'skills.png')

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM11g')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()

  const items = () => ctx.page.locator('[data-testid=skill-item]')
  const openSkills = async () => {
    await T('assistant-settings-open').first().click()
    await T('assistant-settings').waitFor()
    await T('assistant-settings-tab-skills').click()
    await T('skills-panel').waitFor()
  }
  await openSkills()
  check('Skill 页签', '助手设置里有「Skill」页签：列出内置 Skill（标「内置」，可复制），「我的 Skill」暂时为空', (await items().count()) >= 7 && (await ctx.page.locator('[data-testid=skill-copy]').count()) >= 7 && (await count('skill-mine-empty')) === 1 && /内置/.test(await txt('skill-item-source')))

  // 新建
  await T('skill-new').click()
  await T('skill-editor').waitFor()
  await T('skill-name').fill('e2e-demo-skill')
  await T('skill-desc').fill('端到端测试用的一句说明')
  await ctx.page.locator('[data-testid=skill-roles] label', { hasText: '运营' }).click()
  await T('skill-when').fill('测试时')
  await T('skill-body').fill('# 步骤\n1. 先读数据\n2. 引用 `no_such_tool` 看提示')
  await T('skill-save').click()
  check('新建', '保存后「我的 Skill」里出现这一项，来源「我的」，适用角色「运营」', await waitFor(async () => (await ctx.page.locator('[data-testid=skill-item][data-name=e2e-demo-skill]').count()) === 1, 6000)
    && /我的/.test(await ctx.page.locator('[data-testid=skill-item][data-name=e2e-demo-skill] [data-testid=skill-item-source]').innerText()) && /适用：运营/.test(await ctx.page.locator('[data-testid=skill-item][data-name=e2e-demo-skill]').innerText()))
  await ctx.page.screenshot({ path: SHOT })
  // 保存到数据目录 playbooks/
  const pdir = path.join(M.dataDirOf(ud), 'playbooks')
  check('文件', '数据目录 playbooks/ 下生成了带 frontmatter 的 .md', fs.existsSync(pdir) && fs.readdirSync(pdir).some(f => f.endsWith('.md') && /^---\nname: e2e-demo-skill/.test(fs.readFileSync(path.join(pdir, f), 'utf8'))))
  // 同名冲突
  await T('skill-new').click(); await T('skill-editor').waitFor()
  await T('skill-name').fill('e2e-demo-skill'); await T('skill-desc').fill('x'); await T('skill-body').fill('正文')
  await T('skill-save').click()
  check('同名', '再建同名 Skill 被拒绝并提示', await waitFor(async () => /已经有一个叫/.test(await ctx.page.locator('.ant-message').innerText().catch(() => '')), 5000))
  await ctx.page.keyboard.press('Escape'); await T('skill-editor').waitFor({ state: 'detached' })

  // 「＋」菜单里能看到并选中
  await ctx.page.keyboard.press('Escape'); await T('skills-panel').waitFor({ state: 'detached' })
  await T('assistant-plus').click()
  await ctx.page.locator('.ant-dropdown [data-testid=assistant-plus-playbook]').hover()
  const it = ctx.page.locator('[data-testid=assistant-plus-playbook-item]', { hasText: 'e2e-demo-skill' })
  check('＋菜单', '「＋ → 使用 Skill」里能看到新建的 Skill', await waitFor(async () => (await it.count()) === 1, 5000))
  await it.click()
  check('＋菜单', '选中后以小标签出现：Skill · e2e-demo-skill', /Skill · e2e-demo-skill/.test(await txt('assistant-chip')))
  await T('assistant-chip-remove').click()

  // 导入 SKILL.md 文件夹
  const src = path.join(work, 'imp-skill'); fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: imported-demo\ndescription: 导入的测试 Skill\n---\n# 用法\n照着做\n')
  fs.writeFileSync(path.join(src, 'scripts', 'go.sh'), 'echo should-not-run')
  await openSkills()
  await stubOpen(src)
  await T('skill-import-folder').click()
  check('导入', '导入含 SKILL.md 的文件夹：列表出现，来源「导入」，提示脚本不会执行', await waitFor(async () => (await ctx.page.locator('[data-testid=skill-item][data-name=imported-demo]').count()) === 1, 6000)
    && /导入/.test(await ctx.page.locator('[data-testid=skill-item][data-name=imported-demo] [data-testid=skill-item-source]').innerText()) && /脚本不会执行/.test(await ctx.page.locator('.ant-message').innerText()))
  check('导入', '只导入 SKILL.md，脚本没有被复制', !fs.readdirSync(pdir).some(f => /go|scripts/.test(f)))

  // 删除
  for (const n of ['imported-demo', 'e2e-demo-skill']) {
    await ctx.page.locator(`[data-testid=skill-item][data-name=${n}] [data-testid=skill-delete]`).click()
    await T('skill-delete-ok').click()
    check('删除', `删除「${n}」后从列表消失`, await waitFor(async () => (await ctx.page.locator(`[data-testid=skill-item][data-name=${n}]`).count()) === 0, 6000))
  }
  check('删除', '我的 Skill 空了，数据目录里没有残留 .md', (await count('skill-mine-empty')) === 1 && !fs.readdirSync(pdir).some(f => f.endsWith('.md')))
}
const count = async id => T(id).count()

main().then(async () => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11g.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  console.error('渲染端控制台错误：', ctx.consoleErrors.slice(0, 5)); try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11g.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
