const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

// Nếu cửa sổ terminal bị đóng trong lúc đang vẽ giao diện, không để Node báo lỗi EPIPE.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

// The desktop shell passes DOWNLOADER_DATA_DIR: a per-user folder that survives
// app updates (the NSIS updater deletes everything in the install folder).
// When packaged with pkg, __dirname is the read-only /snapshot, so the CLI keeps
// its files next to the EXE instead.
const DATA_DIR = process.env.DOWNLOADER_DATA_DIR || (process.pkg ? path.dirname(process.execPath) : __dirname);
const DESKTOP_MODE = process.argv.includes("--desktop");
const OUTPUT_ROOT = path.join(process.env.USERPROFILE || os.homedir(), "Documents", "chepnhacthenho");
const SEARCH_RESULT_MAX = 20;
const SEARCH_RESULT_DEFAULT = 20;
const YT_SEARCH_MODE = { type: "yt-search" };
const MODES = {
  video: {
    type: "video",
    menuName: "TẢI VIDEO 720P",
    mediaName: "Video",
    linkFile: path.join(DATA_DIR, "link.txt"),
    outputDir: "",
  },
  audio: {
    type: "audio",
    menuName: "TẢI VOICE MP3",
    mediaName: "MP3",
    linkFile: path.join(DATA_DIR, "voice.txt"),
    outputDir: "",
  },
};
let activeMode = MODES.video;

const TOOL_DIR = path.join(DATA_DIR, ".youtube-tools");
// The "onedir" yt-dlp build starts in ~0.6 s; the single-file yt-dlp.exe unpacks
// itself on every launch and takes ~2.4 s, once per video.
const YTDLP_DIR = path.join(TOOL_DIR, "yt-dlp");
const YTDLP_EXE = path.join(YTDLP_DIR, "yt-dlp.exe");
const YTDLP_STATE = path.join(TOOL_DIR, "yt-dlp-state.json");
const YTDLP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const YTDLP_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const DENO_EXE = path.join(TOOL_DIR, "deno.exe");
const FFMPEG_ROOT = path.join(TOOL_DIR, "ffmpeg");
const TEMP_ROOT = path.join(TOOL_DIR, "temp");
const TAR_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const ACTIVE_PROCESSES = new Set();
const ACTIVE_REQUESTS = new Set();
const YTDLP_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
const USER_AGENT = "Mozilla/5.0 YouTubeBatchDownloader/1.0";

const MAX_PARALLEL_DOWNLOADS = 10;
// Only used by fragmented (HLS/DASH) formats; normal YouTube HTTPS formats
// download over a single connection.
const FRAGMENT_THREADS_PER_VIDEO = 16;

// yt-dlp's default YouTube clients return real 720p formats. On some networks those
// streams answer 403; the android client still works there, but only up to 360p,
// so it is used as a fallback instead of always.
const FALLBACK_CLIENT_ARGS = ["--extractor-args", "youtube:player_client=android"];
const FALLBACK_ERROR = /HTTP Error 403|Forbidden|Requested format is not available|page needs to be reloaded/i;
// A link is only treated as dead (and removed from the list) when the extractor
// itself says so. YouTube's rate limit also starts with "Video unavailable", so
// anything that says to try again keeps the link for the next run.
const DEAD_LINK_ERROR = /^ERROR: \[[^\]]+\] [^:]+: (?:Video unavailable|This video is unavailable|.*video has been (?:removed|deleted)|.*removed by the uploader)|is not a valid URL/i;
const TEMPORARY_ERROR = /try again later|rate.?limit|too many requests|available in your country|sign in to confirm/i;

function isDeadLinkError(error) {
  return DEAD_LINK_ERROR.test(error) && !TEMPORARY_ERROR.test(error);
}

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

let renderTimer = null;
let stopRequested = false;

function color(text, code) {
  return `${code}${text}${COLOR.reset}`;
}

function desktopEvent(type, payload = {}) {
  if (!DESKTOP_MODE) return;
  process.stdout.write(`@@DESKTOP@@${JSON.stringify({ type, ...payload })}\n`);
}

function reportStatus(message) {
  if (DESKTOP_MODE) desktopEvent("status", { message });
  else console.log(message);
}

function commandOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* --------------------------------------------------------------------------
   Stopping
   -------------------------------------------------------------------------- */
function killProcessTree(child) {
  if (!child.pid) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

// Kills the running yt-dlp and tar processes, aborts tool downloads and stops new
// downloads from starting. The download loop then finishes normally, so finished
// links still get removed.
function requestStop() {
  if (stopRequested) return;
  stopRequested = true;
  for (const request of ACTIVE_REQUESTS) request.destroy(new Error("Đã dừng."));
  for (const child of ACTIVE_PROCESSES) killProcessTree(child);
}

function stopAndExit(exitCode) {
  console.log(color("\nĐang dừng yt-dlp và FFmpeg...", COLOR.yellow));
  requestStop();
  process.exit(exitCode);
}

process.on("SIGINT", () => stopAndExit(130));
process.on("SIGTERM", () => stopAndExit(143));

// The desktop shell asks for a graceful stop by writing "stop" to stdin. If the
// shell itself goes away, stdin ends: stop too rather than download unattended.
if (DESKTOP_MODE) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("stop")) requestStop();
  });
  process.stdin.on("end", requestStop);
  process.stdin.on("error", () => {});
}

/* --------------------------------------------------------------------------
   Link files
   -------------------------------------------------------------------------- */
function normalizeYouTubeUrl(value) {
  const original = String(value || "").trim();
  if (!original) return "";

  try {
    const parsed = new URL(original);
    const hostname = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    let videoId = "";

    if (hostname === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (hostname === "youtube.com" || hostname === "music.youtube.com") {
      videoId = parsed.searchParams.get("v") || "";
      if (!videoId) {
        const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/i);
        videoId = pathMatch ? pathMatch[1] : "";
      }
    }

    if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  } catch {
    // Giữ nguyên để yt-dlp tự báo link không hợp lệ.
  }

  return original;
}

function uniqueNormalizedLinks(urls) {
  return [...new Set(urls.map(normalizeYouTubeUrl).filter(Boolean))];
}

function parseLinkLines(text) {
  return uniqueNormalizedLinks(String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")));
}

function readLinks(linkFile) {
  if (!fs.existsSync(linkFile)) {
    fs.mkdirSync(path.dirname(linkFile), { recursive: true });
    fs.writeFileSync(linkFile, "", "utf8");
    return [];
  }
  return parseLinkLines(fs.readFileSync(linkFile, "utf8"));
}

function appendUniqueLinks(linkFile, urls) {
  const original = fs.existsSync(linkFile) ? fs.readFileSync(linkFile, "utf8") : "";
  const existingLinks = new Set(parseLinkLines(original));
  const linksToAdd = uniqueNormalizedLinks(urls).filter((url) => !existingLinks.has(url));
  if (linksToAdd.length === 0) return 0;

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const prefix = original && !/[\r\n]$/.test(original) ? newline : "";
  fs.mkdirSync(path.dirname(linkFile), { recursive: true });
  fs.appendFileSync(linkFile, `${prefix}${linksToAdd.join(newline)}${newline}`, "utf8");
  return linksToAdd.length;
}

function removeLinksFromFile(linkFile, urlsToRemove) {
  if (urlsToRemove.size === 0 || !fs.existsSync(linkFile)) return 0;

  const normalizedUrlsToRemove = new Set([...urlsToRemove].map(normalizeYouTubeUrl).filter(Boolean));
  const original = fs.readFileSync(linkFile, "utf8");
  const hasBom = original.startsWith("\uFEFF");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let removed = 0;
  const remainingLines = original
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => {
      if (!normalizedUrlsToRemove.has(normalizeYouTubeUrl(line))) return true;
      removed += 1;
      return false;
    });

  if (removed) {
    // Written to a temporary file and renamed, like the desktop shell's saves, so
    // a reader never sees a half-written list.
    const temporary = `${linkFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${hasBom ? "\uFEFF" : ""}${remainingLines.join(newline)}`, "utf8");
    fs.renameSync(temporary, linkFile);
  }
  return removed;
}

/* --------------------------------------------------------------------------
   Terminal menus (CLI mode)
   -------------------------------------------------------------------------- */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(color(question, COLOR.yellow), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function chooseMode() {
  while (true) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(color("════════════════════════════════════════════", COLOR.cyan));
    console.log(color("       YOUTUBE DOWNLOADER · FULL SPEED", COLOR.bold + COLOR.cyan));
    console.log(color("════════════════════════════════════════════", COLOR.cyan));
    console.log(color("  [1] Tải VIDEO 720p  · đọc link.txt", COLOR.green));
    console.log(color("  [2] Tải VOICE MP3   · đọc voice.txt", COLOR.magenta));
    console.log(color("  [3] Tìm YouTube bằng yt-search rồi tải", COLOR.cyan));
    console.log(color("────────────────────────────────────────────", COLOR.blue));

    const choice = await ask("  Chọn chức năng (1, 2 hoặc 3): ");
    if (choice === "1") return MODES.video;
    if (choice === "2") return MODES.audio;
    if (choice === "3") return YT_SEARCH_MODE;

    console.log(color("\n  Lựa chọn không hợp lệ. Chỉ nhập 1, 2 hoặc 3.", COLOR.red));
    await pause(1200);
  }
}

async function chooseSearchDownloadMode() {
  while (true) {
    console.log(color("\nyt-search tìm link để tải dạng nào?", COLOR.cyan));
    console.log(color("  [1] Video 720p  → link.txt", COLOR.green));
    console.log(color("  [2] Voice MP3   → voice.txt", COLOR.magenta));
    const choice = await ask("Chọn: ");
    if (choice === "1") return MODES.video;
    if (choice === "2") return MODES.audio;
    console.log(color("Lựa chọn không hợp lệ.", COLOR.red));
  }
}

async function askYouTubeSearchQuery() {
  while (true) {
    const query = await ask("Nhập tên bài hát/ca sĩ/chủ đề cần tìm: ");
    if (query) return query;
    console.log(color("Bạn chưa nhập nội dung cần tìm.", COLOR.red));
  }
}

async function askSearchResultLimit() {
  while (true) {
    const value = await ask(`Số link muốn tìm và tải (1-${SEARCH_RESULT_MAX}, Enter = ${SEARCH_RESULT_DEFAULT}): `);
    if (!value) return SEARCH_RESULT_DEFAULT;
    const limit = Number(value);
    if (Number.isInteger(limit) && limit >= 1 && limit <= SEARCH_RESULT_MAX) return limit;
    console.log(color(`Chỉ nhập số nguyên từ 1 đến ${SEARCH_RESULT_MAX}.`, COLOR.red));
  }
}

async function chooseOutputFolder() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const folders = fs
    .readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi", { sensitivity: "base" }));

  if (folders.length === 0) {
    throw new Error(`Chưa có thư mục con nào trong ${OUTPUT_ROOT}. Hãy tạo thư mục như nhactre hoặc nhacvang rồi chạy lại.`);
  }

  while (true) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(color("CHỌN THƯ MỤC LƯU TRƯỚC KHI TẢI", COLOR.bold + COLOR.cyan));
    console.log(color(`Thư mục gốc: ${OUTPUT_ROOT}\n`, COLOR.blue));
    folders.forEach((folder, index) => {
      console.log(color(`  [${index + 1}] ${folder}`, COLOR.green));
    });

    const folderIndex = Number.parseInt(await ask("\nNhập số thư mục muốn lưu: "), 10) - 1;
    if (Number.isInteger(folderIndex) && folderIndex >= 0 && folderIndex < folders.length) {
      return path.join(OUTPUT_ROOT, folders[folderIndex]);
    }

    console.log(color("\nLựa chọn không hợp lệ. Hãy nhập đúng số thư mục trong danh sách.", COLOR.red));
    await pause(1200);
  }
}

function createSearchOutputFolder(query) {
  let folderName = String(query)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/[\s-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .trim()
    .slice(0, 80)
    .replace(/[._]+$/g, "") || "ket_qua_tim_kiem";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(folderName)) {
    folderName = `_${folderName}`;
  }
  const rootDirectory = path.resolve(OUTPUT_ROOT);
  const outputDirectory = path.resolve(rootDirectory, folderName);
  if (!outputDirectory.startsWith(`${rootDirectory}${path.sep}`)) {
    throw new Error("Tên thư mục từ khóa không hợp lệ.");
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

async function chooseNextAction() {
  const waitMilliseconds = 10000;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    let finished = false;
    let timeout = null;
    const finish = (shouldContinue) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      rl.close();
      resolve(shouldContinue);
    };

    console.log(color("\n[1] Tải tiếp", COLOR.green));
    console.log(color("Không nhập gì: tool sẽ tự thoát sau 10 giây.", COLOR.dim));
    timeout = setTimeout(() => finish(false), waitMilliseconds);
    rl.on("close", () => finish(false));
    rl.question(color("Chọn: ", COLOR.yellow), (answer) => {
      finish(answer.trim() === "1");
    });
  });
}

async function searchYouTubeCli(query, limit) {
  // Loaded lazily: the desktop download runner never searches.
  const { searchYouTube } = require("./lib/youtube-search");
  console.log(color(`\nyt-search đang tìm tối đa ${limit} link cho: ${query}`, COLOR.cyan));
  const videos = await searchYouTube(query, limit);

  console.log(color("\nyt-search trả về:", COLOR.magenta));
  if (videos.length === 0) {
    console.log("(Không tìm thấy video YouTube)");
    return [];
  }
  videos.forEach((video, index) => {
    console.log(color(`  [${index + 1}] ${video.title}`, COLOR.magenta));
    console.log(color(`      Đăng: ${video.ago || "không rõ thời gian"}`, COLOR.yellow));
    console.log(color(`      ${video.url}`, COLOR.dim));
  });
  return uniqueNormalizedLinks(videos.map((video) => video.url));
}

/* --------------------------------------------------------------------------
   Terminal dashboard (also feeds the desktop progress list)
   -------------------------------------------------------------------------- */
function shorten(text, maxLength) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 3))}...`;
}

function formatMegabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeSizeLabel(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^~/, "")
    .replace(/KiB/gi, "KB")
    .replace(/MiB/gi, "MB")
    .replace(/GiB/gi, "GB");
  return /^(N\/A|NA|unknown|none)$/i.test(normalized) ? "" : normalized;
}

function progressBar(percent, width = 24) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((safePercent / 100) * width);
  return `${color("█".repeat(filled), COLOR.green)}${color("░".repeat(width - filled), COLOR.dim)}`;
}

function renderDashboard(jobs) {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  const done = jobs.filter((job) => job.status === "done").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  desktopEvent("jobs", {
    heading: activeMode.menuName,
    done,
    failed,
    jobs: jobs.map((job) => ({
      url: job.url,
      title: job.title,
      status: job.status,
      percent: job.percent,
      speed: job.speed,
      error: job.error,
    })),
  });
  if (DESKTOP_MODE) return;

  const columns = Math.max(80, process.stdout.columns || 100);
  const lineWidth = Math.min(columns - 1, 110);
  const active = jobs.filter((job) => ["starting", "downloading", "merging"].includes(job.status)).length;
  const totalBytes = jobs.reduce((sum, job) => sum + (job.fileSizeBytes || 0), 0);
  const lines = [];

  lines.push(color("═".repeat(lineWidth), COLOR.cyan));
  lines.push(
    color(`  ${activeMode.menuName} · FULL SPEED`, COLOR.bold + COLOR.cyan)
      + color(`   Hoàn tất: ${done}/${jobs.length}`, COLOR.green)
      + color(`   Đang tải: ${active}`, COLOR.yellow)
      + (failed ? color(`   Lỗi: ${failed}`, COLOR.red) : "")
      + (totalBytes ? color(`   Đã tải: ${formatMegabytes(totalBytes)}`, COLOR.magenta) : ""),
  );
  lines.push(color("═".repeat(lineWidth), COLOR.cyan));

  jobs.forEach((job, index) => {
    const number = String(index + 1).padStart(String(jobs.length).length, "0");
    const title = shorten(job.title || job.url, Math.max(24, lineWidth - 44));

    if (job.status === "waiting") {
      lines.push(color(`○ [${number}] Chờ tải  ${title}`, COLOR.dim));
    } else if (job.status === "failed") {
      lines.push(color(`✖ [${number}] LỖI      ${title}`, COLOR.red));
      lines.push(color(`  ${shorten(job.error || "Không tải được video", lineWidth - 4)}`, COLOR.red));
    } else if (job.status === "done") {
      const sizeText = job.fileSizeBytes ? `   ${formatMegabytes(job.fileSizeBytes)}` : "";
      lines.push(color(`✔ [${number}] 100.0%${sizeText}   ${title}`, COLOR.green));
    } else if (job.status === "merging") {
      const processingText = activeMode.type === "audio" ? "Đang chuyển đổi sang MP3" : "Đang ghép video + âm thanh";
      lines.push(color(`◆ [${number}] ${processingText}  ${title}`, COLOR.yellow));
    } else {
      const percent = Number(job.percent) || 0;
      const percentText = `${percent.toFixed(1).padStart(5)}%`;
      const sizeProgress = job.downloadedSize ? `${job.downloadedSize}${job.totalSize ? ` / ${job.totalSize}` : ""}` : "";
      const details = [sizeProgress, job.speed, job.eta ? `ETA ${job.eta}` : ""].filter(Boolean).join("  ·  ");
      const activeTitle = shorten(job.title || job.url, Math.max(18, lineWidth - 42 - details.length));
      lines.push(
        `${color(`▶ [${number}]`, COLOR.cyan)} ${progressBar(percent)} ${color(percentText, COLOR.green)}  ${color(activeTitle, COLOR.white)}${details ? color(`  ${details}`, COLOR.dim) : ""}`,
      );
    }
  });

  lines.push(color("─".repeat(lineWidth), COLOR.blue));
  lines.push(color(`  Lưu tại: ${activeMode.outputDir}`, COLOR.blue));

  process.stdout.write(`\x1b[H\x1b[J${lines.join("\n")}\n`);
}

function scheduleRender(jobs) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderDashboard(jobs);
  }, 350);
}

/* --------------------------------------------------------------------------
   Helper tools: yt-dlp, Deno, FFmpeg
   -------------------------------------------------------------------------- */
const DOWNLOADS = {
  ytdlpLatest: "https://github.com/yt-dlp/yt-dlp/releases/latest",
  ytdlpZip: (tag) => `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(tag)}/yt-dlp_win.zip`,
  deno: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
  ffmpeg: "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
};

function reportDownloadProgress(label, percent) {
  if (DESKTOP_MODE) desktopEvent("status", { message: `Đang tải ${label}: ${percent}%` });
  else process.stdout.write(`\rĐang tải ${label}: ${percent}%   `);
}

function downloadFile(url, destination, label, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error(`Quá nhiều lần chuyển hướng khi tải ${label}`));
  }
  if (stopRequested) return Promise.reject(new Error("Đã dừng."));

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
      ACTIVE_REQUESTS.delete(request);
      ACTIVE_REQUESTS.add(response);
      response.on("close", () => ACTIVE_REQUESTS.delete(response));
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFile(nextUrl, destination, label, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Không tải được ${label} (HTTP ${response.statusCode})`));
        return;
      }

      const partialFile = `${destination}.part`;
      const output = fs.createWriteStream(partialFile);
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      let lastPercent = -5;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        response.destroy();
        output.destroy();
        output.once("close", () => fs.rm(partialFile, { force: true }, () => {}));
        reject(error);
      };

      response.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent >= lastPercent + 5) {
            lastPercent = percent;
            reportDownloadProgress(label, percent);
          }
        }
      });
      response.on("aborted", () => fail(new Error(`Mất kết nối khi tải ${label}`)));
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (settled) return;
        if (total > 0 && received < total) {
          fail(new Error(`Tải ${label} chưa đủ dữ liệu`));
          return;
        }
        settled = true;
        output.close(() => {
          try {
            fs.rmSync(destination, { force: true });
            fs.renameSync(partialFile, destination);
          } catch (error) {
            reject(error);
            return;
          }
          if (!DESKTOP_MODE) process.stdout.write(`\rĐã tải ${label}.                    \n`);
          resolve();
        });
      });
      response.pipe(output);
    });

    ACTIVE_REQUESTS.add(request);
    request.setTimeout(60_000, () => request.destroy(new Error(`Hết thời gian tải ${label}`)));
    request.on("error", (error) => {
      ACTIVE_REQUESTS.delete(request);
      reject(error);
    });
  });
}

function extractZip(zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(TAR_EXE, ["-xf", zipFile, "-C", destination], { stdio: "ignore", windowsHide: true });
    ACTIVE_PROCESSES.add(child);
    child.on("error", (error) => {
      ACTIVE_PROCESSES.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      ACTIVE_PROCESSES.delete(child);
      if (code === 0 && !stopRequested) resolve();
      else reject(new Error(stopRequested ? "Đã dừng." : `Không giải nén được ${path.basename(zipFile)}`));
    });
  });
}

// Downloads a zip and unpacks it into a staging folder. Nothing lands at its
// final path until the archive has been extracted completely, so an interrupted
// first run can never leave a truncated deno.exe or ffmpeg.exe behind.
async function downloadAndExtract(url, label, name) {
  const zipFile = path.join(TOOL_DIR, `${name}.zip`);
  const staging = path.join(TOOL_DIR, `${name}.new`);
  fs.rmSync(staging, { recursive: true, force: true });
  await downloadFile(url, zipFile, label);
  try {
    await extractZip(zipFile, staging);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
  return staging;
}

function findFile(folder, wantedName) {
  if (!fs.existsSync(folder)) return null;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wantedName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = findFile(fullPath, wantedName);
      if (found) return found;
    }
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Antivirus scanners briefly lock freshly extracted files, so retry renames.
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await pause(300);
    }
  }
}

// Reads the newest release tag from GitHub's redirect, which (unlike the API) has
// no rate limit.
function latestYtDlpTag() {
  return new Promise((resolve, reject) => {
    const request = https.request(DOWNLOADS.ytdlpLatest, { method: "HEAD", headers: { "User-Agent": USER_AGENT } }, (response) => {
      response.resume();
      const match = String(response.headers.location || "").match(/\/releases\/tag\/([^/?#]+)/);
      if (match) resolve(decodeURIComponent(match[1]));
      else reject(new Error(`không đọc được phiên bản mới nhất (HTTP ${response.statusCode})`));
    });
    request.setTimeout(15_000, () => request.destroy(new Error("hết thời gian kiểm tra phiên bản")));
    request.on("error", reject);
    request.end();
  });
}

async function installYtDlp(tag) {
  const staging = await downloadAndExtract(DOWNLOADS.ytdlpZip(tag), `yt-dlp ${tag}`, "yt-dlp");
  const exe = findFile(staging, "yt-dlp.exe");
  if (!exe) throw new Error("Gói yt-dlp tải về bị thiếu yt-dlp.exe");

  // Move the old copy aside first so a failed swap can be rolled back.
  const previous = `${YTDLP_DIR}.old-${Date.now()}`;
  const hadPrevious = fs.existsSync(YTDLP_DIR);
  if (hadPrevious) await renameWithRetry(YTDLP_DIR, previous);
  try {
    await renameWithRetry(path.dirname(exe), YTDLP_DIR);
  } catch (error) {
    if (hadPrevious) fs.renameSync(previous, YTDLP_DIR);
    throw error;
  }
  // Also drops the single-file yt-dlp.exe used by older versions of this app.
  for (const name of fs.readdirSync(TOOL_DIR)) {
    if (name === "yt-dlp.new" || name === "yt-dlp.exe" || name.startsWith("yt-dlp.old-")) {
      fs.rm(path.join(TOOL_DIR, name), { recursive: true, force: true }, () => {});
    }
  }
}

function writeYtDlpState(state) {
  fs.writeFileSync(YTDLP_STATE, `${JSON.stringify(state)}\n`, "utf8");
}

// Asks for a release check on the next run, for example after downloads failed
// in a way a newer yt-dlp may fix.
function requestYtDlpCheck() {
  const state = readJson(YTDLP_STATE);
  if (state) writeYtDlpState({ ...state, nextCheckAt: 0 });
}

// YouTube changes often and old yt-dlp versions stop working, so look for a new
// release once a day, and an hour after a check that could not reach GitHub.
async function ensureYtDlp() {
  const installed = fs.existsSync(YTDLP_EXE);
  const state = readJson(YTDLP_STATE) || {};
  if (installed && Date.now() < (Number(state.nextCheckAt) || 0)) return;

  try {
    const latest = await latestYtDlpTag();
    if (!installed || latest !== state.version) {
      reportStatus(installed ? `Đang cập nhật yt-dlp lên ${latest}...` : `Đang tải yt-dlp ${latest}...`);
      await installYtDlp(latest);
    }
    writeYtDlpState({ version: latest, nextCheckAt: Date.now() + YTDLP_CHECK_INTERVAL_MS });
  } catch (error) {
    if (stopRequested || !fs.existsSync(YTDLP_EXE)) throw error;
    writeYtDlpState({ ...state, nextCheckAt: Date.now() + YTDLP_RETRY_INTERVAL_MS });
    reportStatus(`Không cập nhật được yt-dlp (${error.message}). Dùng bản hiện có.`);
  }
}

async function ensureDeno() {
  if (fs.existsSync(DENO_EXE)) return;
  const staging = await downloadAndExtract(DOWNLOADS.deno, "Deno", "deno");
  const exe = findFile(staging, "deno.exe");
  if (!exe) throw new Error("Không chuẩn bị được Deno");
  await renameWithRetry(exe, DENO_EXE);
  fs.rmSync(staging, { recursive: true, force: true });
}

async function ensureFfmpeg() {
  const existing = findFile(FFMPEG_ROOT, "ffmpeg.exe");
  if (existing) return existing;
  const staging = await downloadAndExtract(DOWNLOADS.ffmpeg, "FFmpeg", "ffmpeg");
  if (!findFile(staging, "ffmpeg.exe")) throw new Error("Không chuẩn bị được FFmpeg");
  fs.rmSync(FFMPEG_ROOT, { recursive: true, force: true });
  await renameWithRetry(staging, FFMPEG_ROOT);
  return findFile(FFMPEG_ROOT, "ffmpeg.exe");
}

// The three tools are independent, so a first run fetches them at the same time.
// Waits for all of them, so a failure does not leave a download running behind.
async function ensureTools() {
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  const results = await Promise.allSettled([ensureYtDlp(), ensureDeno(), ensureFfmpeg()]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return { ffmpegDirectory: path.dirname(results[2].value) };
}

/* --------------------------------------------------------------------------
   Downloading
   -------------------------------------------------------------------------- */
function createJob(url) {
  return {
    url,
    title: url,
    status: "waiting",
    percent: 0,
    speed: "",
    eta: "",
    downloadedSize: "",
    totalSize: "",
    error: "",
    dead: false,
    filePath: "",
    fileSizeBytes: 0,
  };
}

// Runs `task` over `items` with at most `limit` running at once.
async function runPool(items, limit, task) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length && !stopRequested) {
      const item = items[nextIndex];
      nextIndex += 1;
      await task(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function ytDlpArgs(url, ffmpegDirectory, extraArgs) {
  const mediaArgs = activeMode.type === "audio"
    ? [
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--no-keep-video",
      "--no-write-info-json",
      "--no-write-thumbnail",
      "--no-write-subs",
    ]
    : ["--format", "bv*+ba/b", "--format-sort", "res:720,vcodec:h264,acodec:aac", "--merge-output-format", "mp4"];
  const outputId = crypto.createHash("sha1").update(activeMode.outputDir).digest("hex").slice(0, 12);
  const archiveFile = path.join(TOOL_DIR, `${activeMode.type}-archive-${outputId}.txt`);

  return [
    "--no-playlist",
    "--continue",
    "--retries", "10",
    "--fragment-retries", "10",
    "--concurrent-fragments", String(FRAGMENT_THREADS_PER_VIDEO),
    "--buffer-size", "1M",
    "--windows-filenames",
    "--encoding", "utf-8",
    "--newline",
    "--quiet",
    "--progress",
    "--no-simulate",
    "--no-warnings",
    "--no-color",
    "--progress-delta", "0.2",
    "--print", "before_dl:__YTDLP_TITLE__%(title)s",
    "--print", "after_move:__YTDLP_DONE__%(filepath)s",
    "--progress-template", "download:__YTDLP_PROGRESS__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s",
    "--progress-template", "postprocess:__YTDLP_MERGE__%(info.title)s",
    "--js-runtimes", `deno:${DENO_EXE}`,
    "--ffmpeg-location", ffmpegDirectory,
    "--download-archive", archiveFile,
    ...extraArgs,
    ...mediaArgs,
    "--paths", activeMode.outputDir,
    "--paths", `temp:${path.join(TEMP_ROOT, activeMode.type)}`,
    "--output", "%(title).200B [%(id)s].%(ext)s",
    url,
  ];
}

// Runs one yt-dlp process for `job`, updating its progress as output arrives.
// Resolves to { ok, error }.
function runYtDlp(job, args, jobs) {
  return new Promise((resolve) => {
    const child = spawn(YTDLP_EXE, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: YTDLP_ENV,
    });
    ACTIVE_PROCESSES.add(child);

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const errorLines = [];
    let settled = false;

    function handleOutputLine(rawLine) {
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) return;

      if (line.startsWith("__YTDLP_TITLE__")) {
        job.title = line.slice("__YTDLP_TITLE__".length).trim() || job.title;
        job.status = "downloading";
      } else if (line.startsWith("__YTDLP_PROGRESS__")) {
        const [percentText = "0", speed = "", eta = "", downloadedSize = "", totalSize = "", estimatedSize = ""] = line
          .slice("__YTDLP_PROGRESS__".length)
          .split("|");
        const parsedPercent = Number.parseFloat(percentText.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(parsedPercent)) job.percent = parsedPercent;
        job.speed = speed.trim();
        job.eta = eta.trim();
        job.downloadedSize = normalizeSizeLabel(downloadedSize);
        job.totalSize = normalizeSizeLabel(totalSize) || normalizeSizeLabel(estimatedSize);
        job.status = job.percent >= 99.9 ? "merging" : "downloading";
      } else if (line.startsWith("__YTDLP_MERGE__")) {
        job.status = "merging";
      } else if (line.startsWith("__YTDLP_DONE__")) {
        job.filePath = line.slice("__YTDLP_DONE__".length).trim();
        job.status = "merging";
        job.percent = 100;
      } else {
        return;
      }
      scheduleRender(jobs);
    }

    function handleErrorLine(rawLine) {
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) return;
      errorLines.push(line);
      if (errorLines.length > 4) errorLines.shift();
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/[\r\n]+/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(handleOutputLine);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/[\r\n]+/);
      stderrBuffer = lines.pop() || "";
      lines.forEach(handleErrorLine);
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      ACTIVE_PROCESSES.delete(child);
      resolve(result);
    };
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (stdoutBuffer) handleOutputLine(stdoutBuffer);
      if (stderrBuffer) handleErrorLine(stderrBuffer);
      finish(code === 0
        ? { ok: true, error: "" }
        : { ok: false, error: errorLines.find((line) => line.includes("ERROR:")) || errorLines.at(-1) || `yt-dlp dừng với mã lỗi ${code}` });
    });
  });
}

async function downloadMedia(job, ffmpegDirectory, jobs) {
  job.status = "starting";
  scheduleRender(jobs);

  let result = await runYtDlp(job, ytDlpArgs(job.url, ffmpegDirectory, []), jobs);
  if (!result.ok && !stopRequested && FALLBACK_ERROR.test(result.error)) {
    Object.assign(job, { status: "starting", percent: 0, speed: "", eta: "", downloadedSize: "", totalSize: "" });
    scheduleRender(jobs);
    result = await runYtDlp(job, ytDlpArgs(job.url, ffmpegDirectory, FALLBACK_CLIENT_ARGS), jobs);
  }

  if (result.ok) {
    job.status = "done";
    job.percent = 100;
    try {
      if (job.filePath && fs.existsSync(job.filePath)) job.fileSizeBytes = fs.statSync(job.filePath).size;
    } catch {
      job.fileSizeBytes = 0;
    }
  } else if (stopRequested) {
    // Interrupted by the user: not an error, the link stays for the next run.
    Object.assign(job, { status: "waiting", percent: 0, speed: "", eta: "" });
  } else {
    job.status = "failed";
    job.error = result.error;
    job.dead = isDeadLinkError(result.error);
  }
  scheduleRender(jobs);
}

// Downloads `links` into activeMode.outputDir, then removes finished and dead links
// from the link file. Links whose failure may be temporary stay for the next run.
async function downloadAll(links, ffmpegDirectory) {
  fs.mkdirSync(activeMode.outputDir, { recursive: true });
  fs.mkdirSync(path.join(TEMP_ROOT, activeMode.type), { recursive: true });
  const jobs = links.map(createJob);
  renderDashboard(jobs);

  await runPool(jobs, MAX_PARALLEL_DOWNLOADS, (job) => downloadMedia(job, ffmpegDirectory, jobs));
  renderDashboard(jobs);

  const done = jobs.filter((job) => job.status === "done");
  const failed = jobs.filter((job) => job.status === "failed");
  const dead = failed.filter((job) => job.dead);
  const removed = removeLinksFromFile(activeMode.linkFile, new Set([...done, ...dead].map((job) => job.url)));
  // Live links that failed may need a newer yt-dlp: check for one next run.
  if (failed.length > dead.length) requestYtDlpCheck();
  return {
    jobs,
    succeeded: done.length,
    failed: failed.length,
    dead: dead.length,
    notStarted: jobs.filter((job) => job.status === "waiting").length,
    removed,
  };
}

/* --------------------------------------------------------------------------
   Sessions
   -------------------------------------------------------------------------- */
async function runSession() {
  const selectedMode = await chooseMode();
  let links;
  if (selectedMode === YT_SEARCH_MODE) {
    activeMode = { ...await chooseSearchDownloadMode() };
    const query = await askYouTubeSearchQuery();
    const limit = await askSearchResultLimit();
    links = await searchYouTubeCli(query, limit);
    if (links.length === 0) {
      console.log(color("yt-search không tìm thấy URL video YouTube.", COLOR.yellow));
      return chooseNextAction();
    }
    activeMode.outputDir = createSearchOutputFolder(query);
    const addedCount = appendUniqueLinks(activeMode.linkFile, links);
    console.log(color(`yt-search tìm được ${links.length}/${limit} link. Đã lưu ${addedCount} link mới vào ${activeMode.linkFile}.`, COLOR.cyan));
  } else {
    activeMode = { ...selectedMode };
    activeMode.outputDir = await chooseOutputFolder();
    links = readLinks(activeMode.linkFile);
    if (links.length === 0) {
      console.log(color(`\nFile ${activeMode.linkFile} chưa có link. Thêm mỗi dòng một link YouTube rồi chạy lại.`, COLOR.yellow));
      return chooseNextAction();
    }
  }

  console.log(`Tải ${links.length} link.`);
  console.log(`Thư mục lưu: ${activeMode.outputDir}`);
  console.log("Lần chạy đầu có thể mất vài phút để tải công cụ hỗ trợ.\n");

  const { ffmpegDirectory } = await ensureTools();
  const summary = await downloadAll(links, ffmpegDirectory);

  console.log(color("\nKẾT QUẢ CHI TIẾT", COLOR.bold + COLOR.cyan));
  for (const job of summary.jobs) {
    if (job.status === "done") {
      const sizeText = job.fileSizeBytes ? ` (${formatMegabytes(job.fileSizeBytes)})` : "";
      console.log(color(`✔ ${job.title}${sizeText}`, COLOR.green));
      console.log(color(`  ${job.url}`, COLOR.dim));
    } else {
      console.log(color(`✖ ${job.title}${job.dead ? " (link đã chết)" : ""}`, COLOR.red));
      console.log(color(`  ${job.url}`, COLOR.red));
      if (job.error) console.log(color(`  ${shorten(job.error, 200)}`, COLOR.dim));
    }
  }
  const totalDownloadedBytes = summary.jobs.reduce((sum, job) => sum + (job.fileSizeBytes || 0), 0);
  console.log(color(`\nHoàn tất: ${summary.succeeded}   Lỗi: ${summary.failed}`, summary.failed ? COLOR.yellow : COLOR.green));
  if (totalDownloadedBytes) {
    console.log(color(`Tổng dung lượng: ${formatMegabytes(totalDownloadedBytes)}`, COLOR.magenta));
  }
  console.log(color(`${activeMode.mediaName} nằm tại: ${activeMode.outputDir}`, COLOR.blue));
  if (summary.removed) {
    console.log(color(`Đã xóa ${summary.removed} link đã tải xong hoặc đã chết khỏi ${activeMode.linkFile}.`, COLOR.green));
  }
  const shouldContinue = await chooseNextAction();
  if (!shouldContinue) process.exitCode = summary.failed > 0 ? 1 : 0;
  return shouldContinue;
}

async function main() {
  let shouldContinue = true;
  while (shouldContinue) {
    shouldContinue = await runSession();
  }
}

async function runDesktopSession() {
  const mode = commandOption("--mode");
  const requestedOutputDirectory = commandOption("--output-dir");
  if (!Object.hasOwn(MODES, mode)) throw new Error("Chế độ tải không hợp lệ.");
  if (!requestedOutputDirectory || !path.isAbsolute(requestedOutputDirectory)) throw new Error("Thư mục lưu không hợp lệ.");

  const outputDirectory = path.resolve(requestedOutputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (!fs.statSync(outputDirectory).isDirectory()) throw new Error("Đường dẫn lưu không phải là thư mục.");

  activeMode = { ...MODES[mode], outputDir: outputDirectory };
  const links = readLinks(activeMode.linkFile);
  if (links.length === 0) {
    desktopEvent("complete", { failed: 0, succeeded: 0, message: "Chưa có link để tải." });
    return;
  }

  desktopEvent("status", { message: `Đang chuẩn bị ${links.length} link...` });
  let tools;
  try {
    tools = await ensureTools();
  } catch (error) {
    if (!stopRequested) throw error;
  }
  if (stopRequested) {
    desktopEvent("complete", { failed: 0, succeeded: 0, stopped: true, message: "Đã dừng trước khi tải." });
    return;
  }
  const summary = await downloadAll(links, tools.ffmpegDirectory);

  const parts = [`${summary.succeeded} thành công`, `${summary.failed} lỗi`];
  if (summary.dead) parts.push(`${summary.dead} link chết`);
  if (summary.notStarted) parts.push(`${summary.notStarted} chưa tải`);
  desktopEvent("complete", {
    failed: summary.failed,
    succeeded: summary.succeeded,
    stopped: stopRequested,
    message: `${stopRequested ? "Đã dừng" : "Hoàn tất"}: ${parts.join(", ")}.${summary.removed ? ` Đã xóa ${summary.removed} link đã xong hoặc đã chết khỏi danh sách.` : ""}`,
  });
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

(DESKTOP_MODE ? runDesktopSession() : main())
  .catch((error) => {
    desktopEvent("error", { message: error.message });
    console.error(`\nLỖI: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // stdin stays open for the stop command; release it so the process can exit.
    if (DESKTOP_MODE) process.stdin.destroy();
  });
