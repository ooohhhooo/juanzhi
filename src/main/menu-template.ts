/**
 * macOS 应用菜单的模板（纯数据，不依赖 electron，单测直接加载）。
 * Electron 默认菜单里的「关于 / 隐藏 / 退出」会拼上 app.name，而我们的 app.name 是内部名 english-exam-workbench，
 * 老师会看到「退出 english-exam-workbench」。所以自己建一份中文菜单，名字用 PRODUCT_NAME。
 * 编辑菜单必须有：macOS 上 Cmd+C / V / A 靠菜单里的 role 才生效，缺了输入框里就不能复制粘贴。
 */
import { PRODUCT_NAME } from './brand.ts'

export interface MenuTemplateItem { label?: string; role?: string; type?: 'separator'; submenu?: MenuTemplateItem[] }

export function buildMacMenuTemplate(opts: { dev: boolean }): MenuTemplateItem[] {
  const n = PRODUCT_NAME
  const t: MenuTemplateItem[] = [
    { label: n, submenu: [
      { role: 'about', label: `关于${n}` }, { type: 'separator' },
      { role: 'hide', label: `隐藏${n}` }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' }, { type: 'separator' },
      { role: 'quit', label: `退出${n}` }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
    ] }
  ]
  // 开发时保留重载和开发者工具；打包版不给老师看
  if (opts.dev) t.push({ label: '视图', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'forceReload', label: '强制重新载入' }, { role: 'toggleDevTools', label: '开发者工具' }] })
  t.push({ label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '前置全部窗口' }, { role: 'close', label: '关闭窗口' }] })
  return t
}
