// electron-builder 配置（M5）。用法见 scripts/dist.cjs（npm run dist:mac / dist:win / dist）。
//
// 取舍（每一条都在 docs/M5-交付说明.md 里有说明）：
//  · Mac：dmg，arm64 和 x64 各一个（不做 universal：每个包小一半，老师按「关于本机」下载对应的；安装指南里讲了怎么看）。ad-hoc 签名（identity '-'），不公证。
//  · Windows：NSIS 安装包（可选安装目录、桌面快捷方式、中文界面、默认装到当前用户目录——不需要管理员权限）+ portable，x64。
//  · 在 Mac 上交叉打 Windows 包时没有 Wine：关掉 electron-builder 自带的「用 rcedit 改 exe 图标 / 版本信息」，改由 scripts/after-pack.cjs 用纯 JS 的 resedit 改。
//  · 不带原生 npm 模块：node:sqlite 内置在 Electron 里；pdfjs-dist 的可选依赖 @napi-rs/canvas 只给 Node 里渲染用，我们的 pdf.js 跑在渲染进程里，所以排除。
const path = require('node:path')

const isWin = process.platform === 'win32'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'cn.edu.english-exam-workbench',
  productName: '英语校考分析工作台',
  copyright: '占位版权信息 · 英语校考分析工作台',
  directories: { output: process.env.EWB_BUILD_DIR || 'release', buildResources: 'build' },
  asar: true,
  // 不重建原生模块（本应用没有；也避免交叉打包时去编译 @napi-rs/canvas）
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  electronLanguages: ['zh-CN', 'en-US'],
  afterPack: path.join(__dirname, 'scripts', 'after-pack.cjs'),
  files: [
    'out/**/*',
    'package.json',
    '!**/._*',
    '!**/.DS_Store',
    // pdf.js 只需要渲染进程里读的 legacy/build/pdf.mjs、pdf.worker.mjs，以及 cmaps / standard_fonts（ewb://pdfjs 协议读它们）；其余整套（web 查看器、types、非 legacy 构建、图像解码器）不要
    '!node_modules/pdfjs-dist/{build,web,image_decoders,types}/**',
    '!node_modules/pdfjs-dist/legacy/{web,image_decoders}/**',
    '!node_modules/pdfjs-dist/{webpack.mjs,README.md,CODE_OF_CONDUCT.md}',
    // 压缩版 / 沙箱（PDF 脚本）/ worker 压缩版：我们只读 legacy/build/pdf.mjs 和 pdf.worker.mjs，且不开 PDF 脚本
    '!node_modules/pdfjs-dist/legacy/build/{pdf.min,pdf.worker.min,pdf.sandbox,pdf.sandbox.min}.mjs',
    '!node_modules/zod/src/**',
    '!node_modules/@napi-rs/**',
    '!node_modules/**/*.map',
    // 许可证文件（LICENSE / LICENSE.md / LICENSE.txt）随包保留：MIT 软件分发时要带上许可证文本
    '!node_modules/**/{README,README.md,CHANGELOG.md,HISTORY.md}'
  ],
  // OCR 组件放在 asar 外（要被当作可执行文件 / 脚本启动）：运行时路径 = process.resourcesPath + /native/...（src/main/pipeline/ocr.ts）
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.education',
    icon: 'build/icon.icns',
    // ad-hoc 签名（不是开发者签名）：不公证，首次打开要「右键 → 打开」（见 docs/安装指南.md）
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    minimumSystemVersion: '13.0', // Vision 的中文识别需要 macOS 13+
    artifactName: 'EnglishExamWorkbench-${version}-mac-${arch}.${ext}',
    extraResources: [{ from: 'native/macos/bin/ewb-ocr', to: 'native/macos/bin/ewb-ocr' }],
    extendInfo: { NSHumanReadableCopyright: '占位版权信息' }
  },
  dmg: {
    title: '${productName} ${version}',
    sign: false,
    contents: [
      { x: 150, y: 190, type: 'file' },
      { x: 390, y: 190, type: 'link', path: '/Applications' }
    ],
    window: { width: 540, height: 380 }
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'build/icon.ico',
    executableName: 'EnglishExamWorkbench',
    requestedExecutionLevel: 'asInvoker',
    // 在 Windows 上（含 GitHub Actions 的 windows-latest）用 electron-builder 自带的 rcedit；在 Mac 上没有 Wine，改由 afterPack 里的 resedit 完成
    signAndEditExecutable: isWin,
    extraResources: [{ from: 'native/windows/ocr.ps1', to: 'native/windows/ocr.ps1' }],
    legalTrademarks: '占位版权信息'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '英语校考分析工作台',
    uninstallDisplayName: '英语校考分析工作台',
    language: '2052',
    installerLanguages: ['zh_CN'],
    // 卸载时不删老师的数据（试卷、数据库都在 %APPDATA%\english-exam-workbench 里，安装目录之外）
    deleteAppDataOnUninstall: false,
    artifactName: 'EnglishExamWorkbench-${version}-win-x64-setup.${ext}'
  },
  portable: {
    artifactName: 'EnglishExamWorkbench-${version}-win-x64-portable.${ext}'
  }
}
