/** 数据包导入 / 导出的错误：message 是直接给老师看的中文，code 供测试和界面分辨 */
export type PackErrorCode =
  | 'bad_zip' | 'bad_entry' | 'too_many' | 'too_big' | 'manifest' | 'too_new' | 'bad_format'
  | 'corrupt_db' | 'bad_content' | 'busy' | 'apply_failed' | 'aborted' | 'io'

export class PackError extends Error {
  code: PackErrorCode
  constructor(code: PackErrorCode, message: string) {
    super(message)
    this.name = 'PackError'
    this.code = code
  }
}
