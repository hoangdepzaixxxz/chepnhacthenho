const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("downloader", {
  state: () => ipcRenderer.invoke("app-state"),
  saveLinks: (data) => ipcRenderer.invoke("save-links", data),
  searchYoutube: (data) => ipcRenderer.invoke("search-youtube", data),
  chooseOutputDirectory: () => ipcRenderer.invoke("choose-output-directory"),
  start: (data) => ipcRenderer.invoke("start-download", data),
  stop: () => ipcRenderer.invoke("stop-download"),
  openOutput: () => ipcRenderer.invoke("open-output"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  showUpdateHelp: () => ipcRenderer.invoke("show-update-help"),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  onDownload: (listener) => ipcRenderer.on("download-event", (_event, data) => listener(data)),
  onUpdate: (listener) => ipcRenderer.on("update-status", (_event, data) => listener(data)),
});

contextBridge.exposeInMainWorld("android", {
  getAdbPath: () => ipcRenderer.invoke("adb-path"),
  isAdbDownloaded: () => ipcRenderer.invoke("adb-downloaded"),
  installAdb: () => ipcRenderer.invoke("adb-install-adb"),
  onInstallProgress: (listener) => ipcRenderer.on("adb-install-progress", (_event, data) => listener(data)),
  setAdbPath: (value) => ipcRenderer.invoke("set-adb-path", value),
  browseAdb: () => ipcRenderer.invoke("browse-adb"),
  devices: () => ipcRenderer.invoke("adb-devices"),
  deviceInfo: (serial) => ipcRenderer.invoke("adb-device-info", serial),
  apps: (serial) => ipcRenderer.invoke("adb-apps", serial),
  scan: (serial) => ipcRenderer.invoke("adb-scan", serial),
  appInfo: (serial, pkg) => ipcRenderer.invoke("adb-app-info", { serial, package: pkg }),
  install: (serial) => ipcRenderer.invoke("adb-install", { serial }),
  uninstall: (serial, pkg) => ipcRenderer.invoke("adb-uninstall", { serial, package: pkg }),
});
