import { contextBridge, ipcRenderer } from 'electron'
import type { ApiInfo, TimberBridge, UpdateStatusEvent } from '@shared/types'

const bridge: TimberBridge = {
  getApiInfo: () => ipcRenderer.invoke('api:info'),
  browseLocal: (path) => ipcRenderer.invoke('files:browse', path),
  pathExists: (path) => ipcRenderer.invoke('files:exists', path),
  revealPath: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  copyImage: (src: string) => ipcRenderer.invoke('clipboard:write-image', src),
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winToggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  winIsMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onWindowMaximized: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized)
    ipcRenderer.on('win:maximized-changed', listener)
    return () => ipcRenderer.removeListener('win:maximized-changed', listener)
  },
  winClose: () => ipcRenderer.send('win:close'),
  platform: process.platform,
  appVersion: () => ipcRenderer.invoke('app:version'),
  updaterCheck: () => ipcRenderer.invoke('update-check'),
  updaterDownload: () => ipcRenderer.invoke('update-download'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('update-quit-and-install'),
  updaterSetPrefs: (prefs) => ipcRenderer.send('update-set-prefs', prefs),
  getCurrentReleaseNotes: () => ipcRenderer.invoke('app:current-release-notes'),
  onUpdateStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: UpdateStatusEvent) => cb(payload)
    ipcRenderer.on('update-status-changed', listener)
    return () => ipcRenderer.removeListener('update-status-changed', listener)
  },
  onOpenExternalPage: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, url: string) => cb(url)
    ipcRenderer.on('open-external-page', listener)
    return () => ipcRenderer.removeListener('open-external-page', listener)
  },
  onExtPageStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { url: string; code: number }) =>
      cb(payload)
    ipcRenderer.on('ext-page-status', listener)
    return () => ipcRenderer.removeListener('ext-page-status', listener)
  },
  openInSystemBrowser: (url) => ipcRenderer.invoke('shell:open-external', url),
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),
  onTabShortcut: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, kind: 'close' | 'next') => cb(kind)
    ipcRenderer.on('tab-shortcut', listener)
    return () => ipcRenderer.removeListener('tab-shortcut', listener)
  },
  onApiInfoChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, info: ApiInfo) => cb(info)
    ipcRenderer.on('api-info-changed', listener)
    return () => ipcRenderer.removeListener('api-info-changed', listener)
  },
  archRender: (specJson, cacheKey) => ipcRenderer.invoke('arch:render', specJson, cacheKey),
  archDelta: (baseJson, headJson, cacheKey) =>
    ipcRenderer.invoke('arch:delta', baseJson, headJson, cacheKey)
}

contextBridge.exposeInMainWorld('timber', bridge)
