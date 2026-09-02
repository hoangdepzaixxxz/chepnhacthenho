const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const ytSearchDebugValue = process.env.debug;
delete process.env.debug;
const yts = require("yt-search");
if (ytSearchDebugValue !== undefined) process.env.debug = ytSearchDebugValue;

const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const RENDERER_DIR = app.isPackaged ? path.join(process.resourcesPath, "renderer") : path.join(__dirname, "renderer");
const OUTPUT_ROOT = path.join(process.env.USERPROFILE || os.homedir(), "Documents", "chepnhacthenho");
const UPDATE_CONFIG = path.join(APP_DIR, "update-config.json");
let mainWindow;
let downloader;

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function linkFile(mode) {
  return path.join(APP_DIR, mode === "audio" ? "voice.txt" : "link.txt");
}

function folders() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  return fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi", { sensitivity: "base" }));
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function writeText(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, String(contents || "").replace(/\r?\n/g, "\r\n"), "utf8");
  fs.renameSync(temporary, file);
}

function validFolderName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001F]/.test(name) || /[. ]$/.test(name)) return "";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return "";
  return name;
}

function selectedOutputDirectory(folder) {
  const clean = validFolderName(folder);
  const root = path.resolve(OUTPUT_ROOT);
  const directory = path.resolve(root, clean || "");
  if (!clean || !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error("Tên thư mục lưu không hợp lệ.");
  }
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error("Đường dẫn lưu không phải là thư mục.");
  }
  return directory;
}

function videoAgeMs(ago) {
  const match = String(ago || "").toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(second|minute|hour|day|week|month|year)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  const unitMs = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 26298e5, year: 315576e5 };
  return Number.isFinite(amount) ? amount * unitMs[match[2]] : Number.POSITIVE_INFINITY;
}

async function searchYouTube(query, limit) {
  const cleanQuery = String(query || "").trim();
  const safeLimit = Number(limit);
  if (!cleanQuery) throw new Error("Hãy nhập nội dung cần tìm.");
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 20) throw new Error("Số kết quả phải từ 1 đến 20.");

  const result = await yts(cleanQuery);
  const seen = new Set();
  return (result.videos || [])
    .filter((video) => video.url && video.videoId && !seen.has(video.videoId) && seen.add(video.videoId))
    .map((video, index) => ({ video, index, age: videoAgeMs(video.ago) }))
    .sort((a, b) => a.age - b.age || a.index - b.index)
    .slice(0, safeLimit)
    .map(({ video }) => ({
      title: String(video.title || "Video YouTube"),
      url: video.url,
      ago: String(video.ago || "Không rõ thời gian"),
      duration: String(video.timestamp || ""),
      author: String(video.author?.name || ""),
    }));
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
    fs.writeFileSync(UPDATE_CONFIG, `${JSON.stringify({ url: "" }, null, 2)}\n`, "utf8");
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

function configureUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => send("update-status", { state: "checking", text: "Đang kiểm tra bản cập nhật..." }));
  autoUpdater.on("update-available", (info) => {
    send("update-status", { state: "available", version: info.version, text: `Có bản ${info.version}. Đang tải...` });
    autoUpdater.downloadUpdate().catch((error) => send("update-status", { state: "error", text: `Không thể tải cập nhật: ${error.message}` }));
  });
  autoUpdater.on("update-not-available", () => send("update-status", { state: "current", text: "Bạn đang dùng bản mới nhất." }));
  autoUpdater.on("download-progress", (progress) => send("update-status", { state: "downloading", percent: progress.percent, text: `Đang tải cập nhật: ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => send("update-status", { state: "ready", version: info.version, text: `Đã tải bản ${info.version}. Bấm Cài và khởi động lại.` }));
  autoUpdater.on("error", (error) => send("update-status", { state: "error", text: `Không thể cập nhật: ${error.message}` }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
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

function startDownload({ mode, folder }) {
  if (downloader) throw new Error("Đang có một lượt tải chạy.");
  if (!["video", "audio"].includes(mode)) throw new Error("Chế độ tải không hợp lệ.");
  const outputDirectory = selectedOutputDirectory(folder);
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DOWNLOADER_APP_DIR: APP_DIR };
  downloader = spawn(process.execPath, [path.join(__dirname, "1.js"), "--desktop", "--mode", mode, "--output-dir", outputDirectory], {
    windowsHide: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  parseRunnerOutput(downloader.stdout);
  parseRunnerOutput(downloader.stderr);
  downloader.on("error", (error) => send("download-event", { type: "error", message: error.message }));
  downloader.on("close", (code) => {
    downloader = null;
    send("download-event", { type: "runner-closed", code });
  });
}

ipcMain.handle("app-state", () => ({
  appDir: APP_DIR,
  outputRoot: OUTPUT_ROOT,
  folders: folders(),
  videoLinks: readText(linkFile("video")),
  audioLinks: readText(linkFile("audio")),
  version: app.getVersion(),
  update: updateSettings(),
}));
ipcMain.handle("save-links", (_event, { mode, contents }) => {
  if (!["video", "audio"].includes(mode)) throw new Error("Chế độ tải không hợp lệ.");
  writeText(linkFile(mode), contents);
});
ipcMain.handle("search-youtube", (_event, { query, limit }) => searchYouTube(query, limit));
ipcMain.handle("create-folder", (_event, name) => {
  const clean = validFolderName(name);
  if (!clean) throw new Error("Tên thư mục không hợp lệ.");
  fs.mkdirSync(path.join(OUTPUT_ROOT, clean), { recursive: true });
  return folders();
});
ipcMain.handle("start-download", (_event, payload) => startDownload(payload));
ipcMain.handle("stop-download", () => {
  if (!downloader?.pid) return;
  spawnSync("taskkill.exe", ["/PID", String(downloader.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
});
ipcMain.handle("open-output", async () => {
  const error = await shell.openPath(OUTPUT_ROOT);
  if (error) throw new Error(error);
});
ipcMain.handle("check-update", async () => {
  const settings = configureUpdater();
  if (!settings.available) return { state: "unconfigured", text: settings.message };
  await autoUpdater.checkForUpdates();
  return { state: "started" };
});
ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
ipcMain.handle("show-update-help", () => dialog.showMessageBox(mainWindow, {
  type: "info",
  title: "Thiết lập cập nhật",
  message: "Tạo file update-config.json cạnh file EXE, ví dụ:\n{\n  \"url\": \"https://github.com/TEN-TAI-KHOAN/TEN-REPO/releases/latest/download\"\n}\n\nMỗi bản mới phải có latest.yml và file Setup.exe do electron-builder phát hành.",
}));

app.whenReady().then(() => {
  ensureUpdateConfig();
  configureUpdaterEvents();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (downloader?.pid) spawnSync("taskkill.exe", ["/PID", String(downloader.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); });
