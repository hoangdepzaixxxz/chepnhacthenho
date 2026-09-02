const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("downloader", {
  state: () => ipcRenderer.invoke("app-state"),
  saveLinks: (data) => ipcRenderer.invoke("save-links", data),
  searchYoutube: (data) => ipcRenderer.invoke("search-youtube", data),
  chooseOutputDirectory: () => ipcRenderer.invoke("choose-output-directory"),
  start: (data) => ipcRenderer.invoke("start-download", data),
  stop: () => ipcRenderer.invoke("stop-download"),
  openOutput: () => ipcRenderer.invoke("open-output"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  showUpdateHelp: () => ipcRenderer.invoke("show-update-help"),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  onDownload: (listener) => ipcRenderer.on("download-event", (_event, data) => listener(data)),
  onUpdate: (listener) => ipcRenderer.on("update-status", (_event, data) => listener(data)),
});
