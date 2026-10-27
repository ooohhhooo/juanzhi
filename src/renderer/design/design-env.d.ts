/**
 * 只声明本目录用到的 Vite 能力（项目的 env.d.ts 没引入 vite/client，避免和它的 *?raw 声明重复）。
 */
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly VITE_EWB_DESIGN?: string }
  glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>
}

declare module '*.png' {
  const src: string
  export default src
}

/** 样张图片用 ?inline（内联成 data URI，不单独输出文件）：生产构建里这些模块是死代码，图片不会出现在 out/ 和安装包里 */
declare module '*.png?inline' {
  const src: string
  export default src
}
