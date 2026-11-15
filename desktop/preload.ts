// The only bridge between the interface and the desktop shell: printing, PDF, and folder/file choosers.
// All business data goes through the app's own /api/rpc address instead.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  print: (opts: unknown) => ipcRenderer.invoke("desktop:print", opts),
  savePdf: (opts: unknown) => ipcRenderer.invoke("desktop:savePdf", opts),
  printers: () => ipcRenderer.invoke("desktop:printers"),
  pickFolder: () => ipcRenderer.invoke("desktop:pickFolder"),
  pickBackupFile: () => ipcRenderer.invoke("desktop:pickBackupFile"),
  openFolder: (folder: string) => ipcRenderer.invoke("desktop:openFolder", folder),
  version: () => ipcRenderer.invoke("desktop:version"),
});
