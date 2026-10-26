/**
 * 原生 helper（macOS 的 ewb-ocr）必须有执行位。从干净 checkout 打出来的包、解压工具、拷贝工具都可能把它丢掉（M5 审核 P1-1），
 * 所以运行时再兜底一次：不可执行就尝试 chmod 755，仍不行就给出能看懂的中文原因（调用方据此降级，不让界面只显示「OCR 失败」）。
 * 纯函数模块（不依赖 electron），单测直接加载。
 */
import fs from 'node:fs'

export type ExecCheck = { ok: true; fixed: boolean } | { ok: false; reason: string }

export function ensureExecutable(file: string): ExecCheck {
  try { fs.accessSync(file, fs.constants.X_OK); return { ok: true, fixed: false } } catch { /* 往下：尝试修 */ }
  try {
    fs.chmodSync(file, 0o755)
    fs.accessSync(file, fs.constants.X_OK)
    return { ok: true, fixed: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '未知错误'
    return { ok: false, reason: `OCR 组件没有执行权限，自动修复也没有成功（${code}）。请重新安装本软件；或在「终端」里运行：chmod +x "${file}"` }
  }
}
