import React from 'react'
import { App } from 'antd'
import { useQueryClient } from '@tanstack/react-query'

/** 导入流程：提示结果；内容相同的文件弹窗让用户选「仍然导入」 */
export function useImportFlow() {
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()

  /** 文件夹确认：告诉用户找到多少个文件、跳过多少个（列出前几个和原因），确认后才导入 */
  function confirmFolder(ex: { files: string[]; folders: number; skipped: Array<{ name: string; reason: string }>; skippedMore: number; truncated: boolean }): Promise<boolean> {
    return new Promise(resolve => {
      const shown = ex.skipped.slice(0, 12)
      const skippedTotal = ex.skipped.length + (ex.skippedMore ?? 0)
      modal.confirm({
        title: ex.folders > 1 ? `发现 ${ex.folders} 个文件夹` : '发现文件夹',
        content: (
          <div data-testid="folder-confirm">
            <div>找到 <b data-testid="folder-count">{ex.files.length}</b> 个可以导入的试卷文件{ex.truncated ? '（文件太多，只取了前面一部分，导入完再选一次剩下的）' : ''}，将跳过 <b data-testid="folder-skipped-count">{skippedTotal}</b> 个。</div>
            {shown.length > 0 && (
              <div style={{ marginTop: 8 }} data-testid="folder-skipped">
                <div>跳过的文件：</div>
                {shown.map((k, i) => <div key={i} style={{ opacity: 0.8 }}>· {k.name}（{k.reason}）</div>)}
                {skippedTotal > shown.length && <div style={{ opacity: 0.8 }} data-testid="folder-skipped-more">另有 {skippedTotal - shown.length} 个已跳过</div>}
              </div>
            )}
            <div style={{ marginTop: 8 }}>内容完全相同的文件会再问你一次。</div>
          </div>
        ),
        okText: `导入这 ${ex.files.length} 个`,
        cancelText: '取消',
        okButtonProps: { 'data-testid': 'folder-ok', disabled: ex.files.length === 0 } as any,
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
  }

  async function importPaths(paths: string[], allowDuplicates?: string[]): Promise<void> {
    try {
      let list = paths
      // 先把文件夹展开成里面的文件（重复文件的二次确认走过这一步了，不再展开）
      if (!allowDuplicates && window.api.papers.expandPaths) {
        const ex = await window.api.papers.expandPaths(paths)
        if (ex.folders > 0) {
          if (ex.files.length === 0) { message.warning(`文件夹里没有可以导入的试卷文件${ex.skipped.length ? `（跳过了 ${ex.skipped.length + (ex.skippedMore ?? 0)} 个）` : ''}`); return }
          if (!(await confirmFolder(ex))) return
        }
        list = ex.files
      }
      // 主进程一次最多收 100 个：分批提交
      const results: ImportResult[] = []
      for (let i = 0; i < list.length; i += 100) {
        const part = list.slice(i, i + 100)
        const allow = allowDuplicates ? part.filter(p => allowDuplicates.includes(p)) : undefined
        results.push(...await window.api.papers.import(part, allow ? { allowDuplicates: allow } : undefined))
      }
      const queued = results.filter(r => r.paperId)
      if (queued.length) message.success(`已加入处理队列：${queued.length} 份`)
      const failed = results.filter(r => r.error && r.code !== 'duplicate')
      for (const f of failed.slice(0, 5)) message.warning(`${f.fileName}：${f.error}`)
      if (failed.length > 5) message.warning(`另有 ${failed.length - 5} 个文件没能导入`)
      queryClient.invalidateQueries({ queryKey: ['papers'] })

      const dups = results.filter(r => r.code === 'duplicate')
      if (dups.length) {
        modal.confirm({
          title: '发现内容相同的试卷',
          content: (
            <div data-testid="duplicate-confirm">
              {dups.slice(0, 10).map(d => <div key={d.path}>「{d.fileName}」与已有的「{d.duplicateOf?.title}」内容完全相同{d.duplicateOf?.parseFailed && <b>（那份 AI 解析失败了，请到「处理队列」重试，不必重新导入；仍然导入会再多出一份）</b>}</div>)}
              {dups.length > 10 && <div>……还有 {dups.length - 10} 个内容相同的文件</div>}
              <div style={{ marginTop: 8 }}>是否仍然导入？（统计时同一个文件只算一份，多导入一份不会让它被重复计数；需要时可在看板筛选栏打开「包含重复导入」。）</div>
            </div>
          ),
          okText: '仍然导入',
          cancelText: '跳过',
          okButtonProps: { 'data-testid': 'duplicate-ok' } as any,
          onOk: () => importPaths(dups.map(d => d.path), dups.map(d => d.path))
        })
      }
    } catch (err) {
      message.error(`导入失败: ${(err as Error).message}`)
    }
  }

  /** 取出拖入的文件路径（经 preload 登记授权）；取不到时给出提示 */
  function pathsFromDrop(dt: DataTransfer): string[] {
    if (!window.api?.getPathForFile) {
      message.error('拖拽导入不可用（请在 Electron 中运行）')
      return []
    }
    const paths: string[] = []
    for (const f of Array.from(dt.files)) {
      try {
        const p = window.api.getPathForFile(f)
        if (p) paths.push(p)
      } catch {
        // 取不到路径的条目（比如从浏览器里拖出来的图片）直接忽略
      }
    }
    if (paths.length === 0) message.warning('无法获取文件路径，请拖入本机上的文件')
    return paths
  }

  return { importPaths, pathsFromDrop }
}
