import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopPreload } from '@dsh-desktop/connection/preload'

createDesktopPreload(contextBridge, ipcRenderer)
