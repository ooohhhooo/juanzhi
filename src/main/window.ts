import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}
