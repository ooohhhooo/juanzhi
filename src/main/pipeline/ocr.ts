import { execFile } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'
import type { OcrLine } from '../types'

export interface OcrPageResult {
  lines: OcrLine[]
  width: number
  height: number
}

function getNativePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath!, 'native')
  }
  return path.join(app.getAppPath(), 'native')
}

function getMacOcrBinary(): string {
  return path.join(getNativePath(), 'macos', 'bin', 'ewb-ocr')
}

function getWindowsOcrScript(): string {
  return path.join(getNativePath(), 'windows', 'ocr.ps1')
}

export function ocrImage(imagePath: string): Promise<OcrPageResult> {
  if (process.platform === 'darwin') {
    return runMacOcr(imagePath)
  }
  if (process.platform === 'win32') {
    return runWindowsOcr(imagePath)
  }
  return Promise.reject(new Error(`当前平台 (${process.platform}) 不支持 OCR`))
}

function runMacOcr(imagePath: string): Promise<OcrPageResult> {
  return new Promise((resolve, reject) => {
    const bin = getMacOcrBinary()
    execFile(bin, [imagePath], { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`OCR 失败: ${stderr || err.message}`))
        return
      }
      try {
        const result = JSON.parse(stdout) as OcrPageResult
        resolve(result)
      } catch (e) {
        reject(new Error(`OCR 输出解析失败: ${(e as Error).message}`))
      }
    })
  })
}

function runWindowsOcr(imagePath: string): Promise<OcrPageResult> {
  return new Promise((resolve, reject) => {
    const script = getWindowsOcrScript()
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, imagePath],
      { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const exitCode = (err as any).code
          if (exitCode === 3) {
            reject(new Error('Windows 未安装 OCR 语言包，请在"设置 > 语言"中添加'))
          } else {
            reject(new Error(`OCR 失败: ${stderr || err.message}`))
          }
          return
        }
        try {
          const result = JSON.parse(stdout) as OcrPageResult
          resolve(result)
        } catch (e) {
          reject(new Error(`OCR 输出解析失败: ${(e as Error).message}`))
        }
      }
    )
  })
}

/** macOS：用 ImageIO 解码（含 HEIC）并按 EXIF 方向旋转，输出 PNG */
export function convertImageToPngMac(src: string, destPng: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    execFile(getMacOcrBinary(), ['--convert', src, destPng], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`图片转换失败: ${stderr || err.message}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('图片转换输出解析失败')) }
    })
  })
}

export function isOcrAvailable(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}
