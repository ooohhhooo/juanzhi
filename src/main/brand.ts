/**
 * 对外显示的产品名和应用标识（不依赖 electron，单测直接加载）。
 * 注意：应用内部名 app.name 固定为 english-exam-workbench（为了让 userData 路径不随打包名字变），所以凡是老师会看到的地方
 * （macOS 菜单、「关于」面板、窗口标题）都不能依赖 app.name，要用这里的 PRODUCT_NAME。
 * 两个值必须和 package.json 的 productName、electron-builder.config.cjs 的 appId 一致——单测 packaging-config 会核对。
 */
export const PRODUCT_NAME = '英语校考分析工作台'
export const APP_ID = 'cn.edu.english-exam-workbench'
