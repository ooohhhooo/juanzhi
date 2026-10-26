import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { OcrLine } from '../types'
import { ensureExecutable } from './exec-bit'

export interface OcrPageResult {
  lines: OcrLine[]
  width: number
  height: number
  /** Windows：实际使用的 OCR 语言（如 zh-Hans-CN / en-US） */
  lang?: string
}

export interface OcrStatus {
  available: boolean
  /** 不可用时给用户看的原因；可用时可能带提示（如回退到非中文引擎） */
  detail: string
  lang?: string
}

/** 带原因的 OCR 失败：missing_helper / no_language_pack / timeout / failed */
export class OcrError extends Error {
  constructor(public kind: 'missing_helper' | 'no_language_pack' | 'timeout' | 'failed', message: string) {
    super(message)
  }
}

const OCR_TIMEOUT_MS = 60_000

function getNativePath(): string {
  return app.isPackaged ? path.join(process.resourcesPath!, 'native') : path.join(app.getAppPath(), 'native')
}

function getMacOcrBinary(): string {
  return path.join(getNativePath(), 'macos', 'bin', 'ewb-ocr')
}

/** macOS：helper 必须可执行。不可执行时尝试 chmod 一次，失败给中文原因（missing_helper 走降级流程，而不是笼统的「OCR 失败」） */
function checkMacExecutable(): OcrError | null {
  if (process.platform !== 'darwin') return null
  const r = ensureExecutable(getMacOcrBinary())
  return r.ok ? null : new OcrError('missing_helper', r.reason)
}

function getWindowsOcrScript(): string {
  return path.join(getNativePath(), 'windows', 'ocr.ps1')
}

function getPowerShell(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 去掉 BOM 后解析 JSON */
function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout.replace(/^\uFEFF/, '')) as T
}

function helperPath(): string {
  return process.platform === 'darwin' ? getMacOcrBinary() : getWindowsOcrScript()
}

export function ocrImage(imagePath: string): Promise<OcrPageResult> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return Promise.reject(new OcrError('failed', `当前平台 (${process.platform}) 不支持 OCR`))
  }
  if (!fs.existsSync(helperPath())) {
    return Promise.reject(new OcrError('missing_helper', `找不到 OCR 组件：${helperPath()}（安装包可能不完整）`))
  }
  const notExec = checkMacExecutable()
  if (notExec) return Promise.reject(notExec)
  return process.platform === 'darwin' ? runMacOcr(imagePath) : runWindowsOcr(imagePath)
}

function classify(err: any, stderr: string): OcrError {
  if (err?.killed || err?.signal === 'SIGTERM') return new OcrError('timeout', `OCR 超时（超过 ${OCR_TIMEOUT_MS / 1000} 秒）`)
  if (err?.code === 3) return new OcrError('no_language_pack', 'Windows 未安装 OCR 语言包，请在「设置 → 时间和语言 → 语言」中添加中文（简体）')
  if (err?.code === 'ENOENT') return new OcrError('missing_helper', 'OCR 组件无法启动（文件不存在或被安全软件拦截）')
  if (err?.code === 'EACCES') return new OcrError('missing_helper', 'OCR 组件没有执行权限（或被系统安全设置拦截），请重新安装本软件')
  return new OcrError('failed', `OCR 失败：${(stderr || err?.message || '未知错误').toString().trim().slice(0, 200)}`)
}

function runMacOcr(imagePath: string): Promise<OcrPageResult> {
  return new Promise((resolve, reject) => {
    execFile(getMacOcrBinary(), [imagePath], { maxBuffer: 10 * 1024 * 1024, timeout: OCR_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(classify(err, stderr))
      try { resolve(parseJson<OcrPageResult>(stdout)) }
      catch (e) { reject(new OcrError('failed', `OCR 输出解析失败：${(e as Error).message}`)) }
    })
  })
}

function runWindowsOcr(imagePath: string): Promise<OcrPageResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getPowerShell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', getWindowsOcrScript(), imagePath],
      { maxBuffer: 10 * 1024 * 1024, timeout: OCR_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(classify(err, stderr))
        try { resolve(parseJson<OcrPageResult>(stdout)) }
        catch (e) { reject(new OcrError('failed', `OCR 输出解析失败：${(e as Error).message}`)) }
      }
    )
  })
}

/** macOS：用 ImageIO 解码（含 HEIC）并按 EXIF 方向旋转，输出 PNG */
export function convertImageToPngMac(src: string, destPng: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const notExec = checkMacExecutable()
    if (notExec) { reject(new Error(`图片转换失败: ${notExec.message}`)); return }
    execFile(getMacOcrBinary(), ['--convert', src, destPng], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`图片转换失败: ${stderr || err.message}`))
      try { resolve(parseJson(stdout)) } catch { reject(new Error('图片转换输出解析失败')) }
    })
  })
}

export function isOcrAvailable(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/** 设置页用：不识别图片，只探测组件在不在、语言包有没有 */
export function getOcrStatus(): Promise<OcrStatus> {
  if (!isOcrAvailable()) {
    return Promise.resolve({ available: false, detail: `当前平台 (${process.platform}) 暂不支持 OCR；扫描件只能保存页面图片` })
  }
  if (!fs.existsSync(helperPath())) {
    return Promise.resolve({ available: false, detail: `找不到 OCR 组件（${path.basename(helperPath())}），安装包可能不完整` })
  }
  if (process.platform === 'darwin') {
    const notExec = checkMacExecutable()
    if (notExec) return Promise.resolve({ available: false, detail: notExec.message })
    return Promise.resolve({ available: true, detail: 'macOS Vision（简体中文 + 英文）' })
  }
  return new Promise(resolve => {
    execFile(
      getPowerShell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', getWindowsOcrScript(), '-Check'],
      { timeout: 20_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = classify(err, stderr)
          return resolve({ available: false, detail: e.message })
        }
        try {
          const r = parseJson<{ lang: string }>(stdout)
          const zh = /^zh/i.test(r.lang)
          resolve({
            available: true,
            lang: r.lang,
            detail: zh ? `Windows OCR（${r.lang}）` : `Windows OCR 当前使用 ${r.lang}，中文可能识别不全，请添加中文（简体）语言包`
          })
        } catch (e) {
          resolve({ available: false, detail: `OCR 状态检测输出无法解析：${(e as Error).message}` })
        }
      }
    )
  })
}
