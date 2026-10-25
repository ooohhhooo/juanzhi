import React from 'react'
import { App } from 'antd'
import { useQueryClient } from '@tanstack/react-query'

/** 导入流程：提示结果；内容相同的文件弹窗让用户选「仍然导入」 */
export function useImportFlow() {
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()

  async function importPaths(paths: string[], allowDuplicates?: string[]): Promise<void> {
    try {
      const results = await window.api.papers.import(paths, allowDuplicates ? { allowDuplicates } : undefined)
      const queued = results.filter(r => r.paperId)
      if (queued.length) message.success(`已加入处理队列：${queued.length} 份`)
      for (const f of results.filter(r => r.error && r.code !== 'duplicate')) {
        message.warning(`${f.fileName}：${f.error}`)
      }
      queryClient.invalidateQueries({ queryKey: ['papers'] })

      const dups = results.filter(r => r.code === 'duplicate')
      if (dups.length) {
        modal.confirm({
          title: '发现内容相同的试卷',
          content: (
            <div data-testid="duplicate-confirm">
              {dups.map(d => <div key={d.path}>「{d.fileName}」与已有的「{d.duplicateOf?.title}」内容完全相同</div>)}
              <div style={{ marginTop: 8 }}>是否仍然导入？重复导入会让这份卷子在统计里算两次。</div>
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
