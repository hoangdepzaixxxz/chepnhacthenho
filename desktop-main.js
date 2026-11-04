const { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { searchYouTube } = require("./lib/youtube-search");

const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
// Link lists and the downloaded helper tools live outside the install folder:
// the NSIS updater deletes the whole install folder on every update.
const DATA_DIR = app.isPackaged
  ? path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "AutoMusicPro")
  : __dirname;
const RENDERER_DIR = app.isPackaged ? path.join(process.resourcesPath, "renderer") : path.join(__dirname, "renderer");
const OUTPUT_ROOT = path.join(process.env.USERPROFILE || os.homedir(), "Documents", "chepnhacthenho");
const DOWNLOAD_SETTINGS = path.join(app.getPath("userData"), "download-settings.json");
const UPDATE_CONFIG = path.join(APP_DIR, "update-config.json");
const DEFAULT_UPDATE_URL = "https://github.com/hoangdepzaixxxz/chepnhacthenho/releases/latest/download";
let mainWindow;
let downloader;
let updateAvailableNotified = false;
let updateReadyNotified = false;

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function linkFile(mode) {
  return path.join(DATA_DIR, mode === "audio" ? "voice.txt" : "link.txt");
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function writeText(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, String(contents || "").replace(/\r?\n/g, "\r\n"), "utf8");
  fs.renameSync(temporary, file);
}

function resolveOutputDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("Thư mục lưu không hợp lệ.");
  }
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error("Đường dẫn đã chọn không phải là thư mục.");
  }
  return directory;
}

function currentOutputDirectory() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  try {
    const settings = JSON.parse(fs.readFileSync(DOWNLOAD_SETTINGS, "utf8"));
    return resolveOutputDirectory(settings.outputDirectory);
  } catch {
    return OUTPUT_ROOT;
  }
}

function saveOutputDirectory(directory) {
  fs.mkdirSync(path.dirname(DOWNLOAD_SETTINGS), { recursive: true });
  fs.writeFileSync(DOWNLOAD_SETTINGS, `${JSON.stringify({ outputDirectory: directory }, null, 2)}\n`, "utf8");
}

async function chooseOutputDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn thư mục lưu file tải về",
    defaultPath: currentOutputDirectory(),
    buttonLabel: "Chọn thư mục này",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return currentOutputDirectory();
  const directory = resolveOutputDirectory(result.filePaths[0]);
  saveOutputDirectory(directory);
  return directory;
}

function searchVideos(query, limit) {
  const cleanQuery = String(query || "").trim();
  const safeLimit = Number(limit);
  if (!cleanQuery) throw new Error("Hãy nhập nội dung cần tìm.");
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) throw new Error("Số kết quả phải từ 1 đến 100.");
  return searchYouTube(cleanQuery, safeLimit);
}

function updateSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(UPDATE_CONFIG, "utf8"));
    if (typeof settings.url !== "string" || !/^https:\/\//i.test(settings.url)) {
      throw new Error("url phải là địa chỉ https");
    }
    return { available: true, url: settings.url.replace(/\/$/, "") };
  } catch (error) {
    return { available: false, message: `Chưa cấu hình cập nhật (${error.message}).` };
  }
}

function ensureUpdateConfig() {
  if (!app.isPackaged || fs.existsSync(UPDATE_CONFIG)) return;
  try {
    fs.writeFileSync(UPDATE_CONFIG, `${JSON.stringify({ url: DEFAULT_UPDATE_URL }, null, 2)}\n`, "utf8");
  } catch {
    // The UI will show the configuration issue if this installation directory is read-only.
  }
}

function configureUpdater() {
  const settings = updateSettings();
  if (!settings.available) return settings;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: "generic", url: settings.url });
  return settings;
}

async function checkForUpdates() {
  const settings = configureUpdater();
  if (!settings.available) return { state: "unconfigured", text: settings.message };
  await autoUpdater.checkForUpdates();
  return { state: "started" };
}

function configureUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => send("update-status", { state: "checking", text: "Đang kiểm tra bản cập nhật..." }));
  autoUpdater.on("update-available", (info) => {
    send("update-status", { state: "available", version: info.version, text: `Có bản ${info.version}. Đang tải...` });
    if (!updateAvailableNotified && mainWindow && !mainWindow.isDestroyed()) {
      updateAvailableNotified = true;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Có bản cập nhật mới",
        message: `Đã có phiên bản ${info.version}.`,
        detail: "Ứng dụng đang tự tải bản cập nhật ở nền. Bạn có thể tiếp tục sử dụng bình thường.",
        buttons: ["Đã hiểu"],
      }).catch(() => {});
    }
    autoUpdater.downloadUpdate().catch((error) => send("update-status", { state: "error", text: `Không thể tải cập nhật: ${error.message}` }));
  });
  autoUpdater.on("update-not-available", () => send("update-status", { state: "current", text: "Bạn đang dùng bản mới nhất." }));
  autoUpdater.on("download-progress", (progress) => send("update-status", { state: "downloading", percent: progress.percent, text: `Đang tải cập nhật: ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => {
    send("update-status", { state: "ready", version: info.version, text: `Đã tải bản ${info.version}. Bấm Cài và khởi động lại.` });
    if (!updateReadyNotified && mainWindow && !mainWindow.isDestroyed()) {
      updateReadyNotified = true;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Bản cập nhật đã sẵn sàng",
        message: `Bản ${info.version} đã tải xong.`,
        detail: "Chọn Cài ngay để khởi động lại ứng dụng và hoàn tất cập nhật.",
        buttons: ["Cài ngay", "Để sau"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      }).catch(() => {});
    }
  });
  autoUpdater.on("error", (error) => send("update-status", { state: "error", text: `Không thể cập nhật: ${error.message}` }));
}

function resolveAppIcon() {
  const icoPath = path.join(RENDERER_DIR, "assets", "app.ico");
  if (fs.existsSync(icoPath)) return icoPath;
  const pngPath = path.join(RENDERER_DIR, "assets", "logo.png");
  if (fs.existsSync(pngPath)) return pngPath;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "AutoMusic Pro – Chép Nhạc Thẻ Nhớ",
    icon: resolveAppIcon(),
    width: 1140,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(RENDERER_DIR, "index.html"));
}

function parseRunnerOutput(stream) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const marker = "@@DESKTOP@@";
      const index = line.indexOf(marker);
      if (index < 0) continue;
      try { send("download-event", JSON.parse(line.slice(index + marker.length))); } catch { /* Ignore non-JSON output. */ }
    }
  });
}

function startDownload({ mode, outputDirectory } = {}) {
  if (downloader) throw new Error("Đang có một lượt tải chạy.");
  if (!["video", "audio"].includes(mode)) throw new Error("Chế độ tải không hợp lệ.");
  // When no folder was chosen in the interface, this creates and uses the
  // default Documents\chepnhacthenho directory.
  const destination = resolveOutputDirectory(outputDirectory || currentOutputDirectory());
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DOWNLOADER_DATA_DIR: DATA_DIR };
  const runner = spawn(process.execPath, [path.join(__dirname, "1.js"), "--desktop", "--mode", mode, "--output-dir", destination], {
    windowsHide: true,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  downloader = runner;
  runner.stdin.on("error", () => {});
  parseRunnerOutput(runner.stdout);
  parseRunnerOutput(runner.stderr);
  runner.on("error", (error) => send("download-event", { type: "error", message: error.message }));
  runner.on("close", (code) => {
    clearTimeout(runner.killTimer);
    if (downloader === runner) downloader = null;
    send("download-event", { type: "runner-closed", code });
  });
}

function killDownloader() {
  if (!downloader?.pid) return;
  spawnSync("taskkill.exe", ["/PID", String(downloader.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

// Asks the runner to stop so it can still remove the links it finished; kills it
// if it has not exited a few seconds later.
function stopDownload() {
  const runner = downloader;
  if (!runner?.pid || runner.killTimer) return;
  runner.stdin.write("stop\n");
  runner.killTimer = setTimeout(() => {
    if (downloader === runner) killDownloader();
  }, 8000);
}

ipcMain.handle("app-state", () => ({
  outputDirectory: currentOutputDirectory(),
  videoLinks: readText(linkFile("video")),
  audioLinks: readText(linkFile("audio")),
  version: app.getVersion(),
  update: updateSettings(),
}));
ipcMain.handle("save-links", (_event, { mode, contents }) => {
  if (!["video", "audio"].includes(mode)) throw new Error("Chế độ tải không hợp lệ.");
  writeText(linkFile(mode), contents);
});
ipcMain.handle("search-youtube", (_event, { query, limit }) => searchVideos(query, limit));
ipcMain.handle("start-download", (_event, payload) => startDownload(payload));
ipcMain.handle("choose-output-directory", chooseOutputDirectory);
ipcMain.handle("stop-download", stopDownload);
ipcMain.handle("open-output", async () => {
  const error = await shell.openPath(currentOutputDirectory());
  if (error) throw new Error(error);
});
ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.handle("check-update", checkForUpdates);
ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
ipcMain.handle("show-update-help", () => dialog.showMessageBox(mainWindow, {
  type: "info",
  title: "Thiết lập cập nhật",
  message: "Tạo file update-config.json cạnh file EXE, ví dụ:\n{\n  \"url\": \"https://github.com/TEN-TAI-KHOAN/TEN-REPO/releases/latest/download\"\n}\n\nMỗi bản mới phải có latest.yml và file Setup.exe do electron-builder phát hành.",
}));
ipcMain.handle("set-theme", (_event, theme) => {
  if (["dark", "light", "system"].includes(theme)) {
    nativeTheme.themeSource = theme;
    // Matches the page ground, so resizing never shows a band of the other theme.
    mainWindow?.setBackgroundColor(theme === "light" ? "#f9fafb" : "#000000");
  }
});

app.whenReady().then(() => {
  ensureUpdateConfig();
  configureUpdaterEvents();
  createWindow();
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates().catch((error) => send("update-status", { state: "error", text: `Không thể kiểm tra cập nhật: ${error.message}` })), 1500);
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", killDownloader);
