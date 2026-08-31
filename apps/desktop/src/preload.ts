import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopPreload } from '@dsh-desktop/connection/preload'
import { createNativeThemePreload } from './native-window.js'

createDesktopPreload(contextBridge, ipcRenderer)
createNativeThemePreload(contextBridge, ipcRenderer)
