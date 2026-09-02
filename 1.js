const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const ytSearchDebugValue = process.env.debug;
delete process.env.debug;
const yts = require("yt-search");
if (ytSearchDebugValue !== undefined) process.env.debug = ytSearchDebugValue;
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");

// Neu cua so terminal bi dong trong luc dang ve giao dien, khong de Node bao loi EPIPE.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

// Khi đóng gói bằng pkg, __dirname nằm trong vùng chỉ đọc /snapshot.
// Dùng thư mục chứa file EXE để link.txt, voice.txt và công cụ hỗ trợ luôn ghi được.
// DOWNLOADER_APP_DIR is supplied by the desktop shell. It keeps writable files
// beside the installed EXE rather than inside Electron's read-only app archive.
const APP_DIR = process.env.DOWNLOADER_APP_DIR || (process.pkg ? path.dirname(process.execPath) : __dirname);
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
    linkFile: path.join(APP_DIR, "link.txt"),
    outputDir: "",
  },
  audio: {
    type: "audio",
    menuName: "TẢI VOICE MP3",
    mediaName: "MP3",
    linkFile: path.join(APP_DIR, "voice.txt"),
    outputDir: "",
  },
};
let activeMode = MODES.video;
const TOOL_DIR = path.join(APP_DIR, ".youtube-tools");
const YTDLP_EXE = path.join(TOOL_DIR, "yt-dlp.exe");
const DENO_EXE = path.join(TOOL_DIR, "deno.exe");
const FFMPEG_ROOT = path.join(TOOL_DIR, "ffmpeg");
const TEMP_ROOT = path.join(TOOL_DIR, "temp");
const ACTIVE_DOWNLOADS = new Set();
const YTDLP_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

// FULL SPEED: chiem toi da bang thong mang de tai nhanh nhat co the.
const MAX_PARALLEL_DOWNLOADS = 10;
const FRAGMENT_THREADS_PER_VIDEO = 16;

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
let isStopping = false;

function desktopEvent(type, payload = {}) {
  if (!DESKTOP_MODE) return;
  process.stdout.write(`@@DESKTOP@@${JSON.stringify({ type, ...payload })}\n`);
}

function commandOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function stopAllDownloads(exitCode = 130) {
  if (isStopping) return;
  isStopping = true;
  console.log(color("\nĐang dừng yt-dlp, aria2 và FFmpeg...", COLOR.yellow));

  for (const child of ACTIVE_DOWNLOADS) {
    if (!child.pid) continue;
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => stopAllDownloads(130));
process.on("SIGTERM", () => stopAllDownloads(143));

function color(text, code) {
  return `${code}${text}${COLOR.reset}`;
}

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
    // Giữ nguyên để yt-dlp tự báo link không hợp lệ ở bước kiểm tra.
  }

  return original;
}

function uniqueNormalizedLinks(urls) {
  const seen = new Set();
  const result = [];
  for (const value of urls) {
    const url = normalizeYouTubeUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

async function chooseMode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(color("════════════════════════════════════════════", COLOR.cyan));
      console.log(color("       YOUTUBE DOWNLOADER · FULL SPEED", COLOR.bold + COLOR.cyan));
      console.log(color("════════════════════════════════════════════", COLOR.cyan));
      console.log(color("  [1] Tải VIDEO 720p  · đọc link.txt", COLOR.green));
      console.log(color("  [2] Tải VOICE MP3   · đọc voice.txt", COLOR.magenta));
      console.log(color("  [3] Tìm YouTube bằng yt-search rồi tải", COLOR.cyan));
      console.log(color("────────────────────────────────────────────", COLOR.blue));

      const answer = await new Promise((resolve) => {
        rl.question(color("  Chọn chức năng (1, 2 hoặc 3): ", COLOR.yellow), resolve);
      });
      const choice = answer.trim();
      if (choice === "1") return MODES.video;
      if (choice === "2") return MODES.audio;
      if (choice === "3") return YT_SEARCH_MODE;

      console.log(color("\n  Lựa chọn không hợp lệ. Chỉ nhập 1, 2 hoặc 3.", COLOR.red));
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    rl.close();
  }
}

async function chooseSearchDownloadMode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      console.log(color("\nyt-search tìm link để tải dạng nào?", COLOR.cyan));
      console.log(color("  [1] Video 720p  → link.txt", COLOR.green));
      console.log(color("  [2] Voice MP3   → voice.txt", COLOR.magenta));
      const answer = await new Promise((resolve) => {
        rl.question(color("Chọn: ", COLOR.yellow), resolve);
      });
      if (answer.trim() === "1") return MODES.video;
      if (answer.trim() === "2") return MODES.audio;
      console.log(color("Lựa chọn không hợp lệ.", COLOR.red));
    }
  } finally {
    rl.close();
  }
}

async function askYouTubeSearchQuery() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise((resolve) => {
        rl.question(color("Nhập tên bài hát/ca sĩ/chủ đề cần tìm: ", COLOR.yellow), resolve);
      });
      const query = answer.trim();
      if (query) return query;
      console.log(color("Bạn chưa nhập nội dung cần tìm.", COLOR.red));
    }
  } finally {
    rl.close();
  }
}

async function askSearchResultLimit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise((resolve) => {
        rl.question(
          color(`Số link muốn tìm và tải (1-${SEARCH_RESULT_MAX}, Enter = ${SEARCH_RESULT_DEFAULT}): `, COLOR.yellow),
          resolve,
        );
      });
      const value = answer.trim();
      if (!value) return SEARCH_RESULT_DEFAULT;

      const limit = Number(value);
      if (Number.isInteger(limit) && limit >= 1 && limit <= SEARCH_RESULT_MAX) {
        return limit;
      }
      console.log(color(`Chỉ nhập số nguyên từ 1 đến ${SEARCH_RESULT_MAX}.`, COLOR.red));
    }
  } finally {
    rl.close();
  }
}

function appendUniqueLinks(linkFile, urls) {
  const original = fs.existsSync(linkFile) ? fs.readFileSync(linkFile, "utf8") : "";
  const existingLinks = new Set(
    uniqueNormalizedLinks(original
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))),
  );
  const linksToAdd = uniqueNormalizedLinks(urls).filter((url) => !existingLinks.has(url));
  if (linksToAdd.length === 0) return 0;

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const prefix = original && !/[\r\n]$/.test(original) ? newline : "";
  fs.appendFileSync(linkFile, `${prefix}${linksToAdd.join(newline)}${newline}`, "utf8");
  return linksToAdd.length;
}

function getVideoAgeMs(ago) {
  const text = String(ago || "").trim().toLowerCase();
  if (!text) return Number.POSITIVE_INFINITY;
  if (/^(just now|vừa xong|mới đăng|mới phát hành)$/.test(text)) return 0;

  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(second|minute|hour|day|week|month|year|giây|phút|giờ|ngày|tuần|tháng|năm)/u);
  if (!match) return Number.POSITIVE_INFINITY;

  const amount = Number.parseFloat(match[1].replace(",", "."));
  const unit = match[2];
  const unitMs = {
    second: 1_000,
    "giây": 1_000,
    minute: 60_000,
    "phút": 60_000,
    hour: 3_600_000,
    "giờ": 3_600_000,
    day: 86_400_000,
    "ngày": 86_400_000,
    week: 604_800_000,
    "tuần": 604_800_000,
    month: 2_629_800_000,
    "tháng": 2_629_800_000,
    year: 31_557_600_000,
    "năm": 31_557_600_000,
  };
  return Number.isFinite(amount) && unitMs[unit] ? amount * unitMs[unit] : Number.POSITIVE_INFINITY;
}

function prioritizeNewlyUploadedVideos(videos) {
  return videos
    .map((video, index) => ({ video, index, ageMs: getVideoAgeMs(video.ago) }))
    .sort((a, b) => a.ageMs - b.ageMs || a.index - b.index)
    .map(({ video }) => video);
}

async function searchYouTube(query, limit) {
  console.log(color(`\nyt-search đang tìm tối đa ${limit} link cho: ${query}`, COLOR.cyan));
  const result = await yts(query);
  const seenVideoIds = new Set();
  const candidates = (result.videos || [])
    .filter((video) => {
      if (!video.url || !video.videoId || seenVideoIds.has(video.videoId)) return false;
      seenVideoIds.add(video.videoId);
      return true;
    });
  const videos = prioritizeNewlyUploadedVideos(candidates).slice(0, limit);

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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(color("CHỌN THƯ MỤC LƯU TRƯỚC KHI TẢI", COLOR.bold + COLOR.cyan));
      console.log(color(`Thư mục gốc: ${OUTPUT_ROOT}\n`, COLOR.blue));
      folders.forEach((folder, index) => {
        console.log(color(`  [${index + 1}] ${folder}`, COLOR.green));
      });

      const answer = await new Promise((resolve) => {
        rl.question(color("\nNhập số thư mục muốn lưu: ", COLOR.yellow), resolve);
      });
      const folderIndex = Number.parseInt(answer.trim(), 10) - 1;
      if (Number.isInteger(folderIndex) && folderIndex >= 0 && folderIndex < folders.length) {
        return path.join(OUTPUT_ROOT, folders[folderIndex]);
      }

      console.log(color("\nLựa chọn không hợp lệ. Hãy nhập đúng số thư mục trong danh sách.", COLOR.red));
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    rl.close();
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

function renderDashboard(jobs, force = false) {
  if (renderTimer && force) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  const columns = Math.max(80, process.stdout.columns || 100);
  const lineWidth = Math.min(columns - 1, 110);
  const done = jobs.filter((job) => job.status === "done").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const active = jobs.filter((job) => ["starting", "downloading", "merging"].includes(job.status)).length;
  const totalBytes = jobs.reduce((sum, job) => sum + (job.fileSizeBytes || 0), 0);
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

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const number = String(index + 1).padStart(String(jobs.length).length, "0");
    const title = shorten(job.title || job.url, Math.max(24, lineWidth - 44));

    if (job.status === "waiting") {
      lines.push(color(`○ [${number}] Chờ tải  ${title}`, COLOR.dim));
      continue;
    }

    if (job.status === "failed") {
      lines.push(color(`✖ [${number}] LỖI      ${title}`, COLOR.red));
      lines.push(color(`  ${shorten(job.error || "Không tải được video", lineWidth - 4)}`, COLOR.red));
      continue;
    }

    if (job.status === "done") {
      const sizeText = job.fileSizeBytes ? `   ${formatMegabytes(job.fileSizeBytes)}` : "";
      lines.push(color(`✔ [${number}] 100.0%${sizeText}   ${title}`, COLOR.green));
      continue;
    }

    if (job.status === "merging") {
      const processingText = activeMode.type === "audio"
        ? "Đang chuyển đổi sang MP3"
        : "Đang ghép video + âm thanh";
      lines.push(color(`◆ [${number}] ${processingText}  ${title}`, COLOR.yellow));
      continue;
    }

    const percent = Number(job.percent) || 0;
    const percentText = `${percent.toFixed(1).padStart(5)}%`;
    const sizeProgress = job.downloadedSize
      ? `${job.downloadedSize}${job.totalSize ? ` / ${job.totalSize}` : ""}`
      : "";
    const details = [sizeProgress, job.speed, job.eta ? `ETA ${job.eta}` : ""].filter(Boolean).join("  ·  ");
    const activeTitle = shorten(job.title || job.url, Math.max(18, lineWidth - 42 - details.length));
    lines.push(
      `${color(`▶ [${number}]`, COLOR.cyan)} ${progressBar(percent)} ${color(percentText, COLOR.green)}  ${color(activeTitle, COLOR.white)}${details ? color(`  ${details}`, COLOR.dim) : ""}`,
    );
  }

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

const DOWNLOADS = {
  ytdlp: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
  deno: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
  ffmpeg: "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
};

function downloadFile(url, destination, label, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error(`Qua nhieu lan chuyen huong khi tai ${label}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 YouTubeBatchDownloader/1.0" } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, url).toString();
          downloadFile(nextUrl, destination, label, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Khong tai duoc ${label} (HTTP ${response.statusCode})`));
          return;
        }

        const partialFile = `${destination}.part`;
        const output = fs.createWriteStream(partialFile);
        const total = Number(response.headers["content-length"] || 0);
        let received = 0;
        let lastPercent = -1;

        response.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const percent = Math.floor((received / total) * 100);
            if (percent >= lastPercent + 5 || percent === 100) {
              lastPercent = percent;
              process.stdout.write(`\rDang tai ${label}: ${percent}%`);
            }
          }
        });

        response.pipe(output);
        output.on("finish", () => {
          output.close(() => {
            fs.rmSync(destination, { force: true });
            fs.renameSync(partialFile, destination);
            process.stdout.write(`\rDa tai ${label}.                    \n`);
            resolve();
          });
        });
        output.on("error", (error) => {
          response.destroy();
          fs.rmSync(partialFile, { force: true });
          reject(error);
        });
      },
    );

    request.setTimeout(60_000, () => request.destroy(new Error(`Het thoi gian tai ${label}`)));
    request.on("error", reject);
  });
}

function extractZip(zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync("tar.exe", ["-xf", zipFile, "-C", destination], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Khong giai nen duoc ${path.basename(zipFile)}`);
  }
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

async function ensureTools() {
  fs.mkdirSync(TOOL_DIR, { recursive: true });

  if (!fs.existsSync(YTDLP_EXE)) {
    await downloadFile(DOWNLOADS.ytdlp, YTDLP_EXE, "yt-dlp");
  }

  if (!fs.existsSync(DENO_EXE)) {
    const denoZip = path.join(TOOL_DIR, "deno.zip");
    await downloadFile(DOWNLOADS.deno, denoZip, "Deno");
    extractZip(denoZip, TOOL_DIR);
    fs.rmSync(denoZip, { force: true });
  }

  let ffmpegExe = findFile(FFMPEG_ROOT, "ffmpeg.exe");
  if (!ffmpegExe) {
    const ffmpegZip = path.join(TOOL_DIR, "ffmpeg.zip");
    await downloadFile(DOWNLOADS.ffmpeg, ffmpegZip, "FFmpeg");
    extractZip(ffmpegZip, FFMPEG_ROOT);
    fs.rmSync(ffmpegZip, { force: true });
    ffmpegExe = findFile(FFMPEG_ROOT, "ffmpeg.exe");
  }

  if (!fs.existsSync(YTDLP_EXE) || !fs.existsSync(DENO_EXE) || !ffmpegExe) {
    throw new Error("Khong chuan bi duoc yt-dlp, Deno hoac FFmpeg");
  }

  return { ffmpegDirectory: path.dirname(ffmpegExe) };
}

function readLinks(linkFile, allowEmptyFile = false) {
  if (!fs.existsSync(linkFile)) {
    fs.writeFileSync(linkFile, "", "utf8");
    if (allowEmptyFile) return [];
    throw new Error(`Đã tạo file ${linkFile}. Hãy thêm mỗi dòng một link rồi chạy lại.`);
  }

  return uniqueNormalizedLinks(fs
    .readFileSync(linkFile, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")));
}

function removeLinksFromFile(linkFile, urlsToRemove) {
  if (urlsToRemove.size === 0 || !fs.existsSync(linkFile)) return 0;

  const normalizedUrlsToRemove = new Set(
    [...urlsToRemove].map(normalizeYouTubeUrl).filter(Boolean),
  );

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

  fs.writeFileSync(linkFile, `${hasBom ? "\uFEFF" : ""}${remainingLines.join(newline)}`, "utf8");
  return removed;
}

function classifyLinkCheckFailure(message) {
  const definitelyDead = /video unavailable|this video is unavailable|video has been removed|video has been deleted|removed by the uploader|not a valid url|http error 404|\b404 not found\b/i;
  return definitelyDead.test(message) ? "dead" : "unknown";
}

function checkLink(url) {
  const args = [
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--no-progress",
    "--no-color",
    "--encoding", "utf-8",
    "--retries", "2",
    "--socket-timeout", "20",
    "--js-runtimes", `deno:${DENO_EXE}`,
    "--print", "%(id)s",
    url,
  ];

  return new Promise((resolve) => {
    const child = spawn(YTDLP_EXE, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: YTDLP_ENV,
    });
    ACTIVE_DOWNLOADS.add(child);

    let errorOutput = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ACTIVE_DOWNLOADS.delete(child);
      resolve(result);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
      if (errorOutput.length > 4000) errorOutput = errorOutput.slice(-4000);
    });
    child.on("error", (error) => {
      finish({ url, status: "unknown", error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ url, status: "live", error: "" });
        return;
      }
      finish({
        url,
        status: classifyLinkCheckFailure(errorOutput),
        error: errorOutput.trim() || `yt-dlp dừng với mã lỗi ${code}`,
      });
    });
  });
}

async function validateLinks(links) {
  console.log(color(`\nĐang kiểm tra ${links.length} link trước khi tải...`, COLOR.cyan));
  const results = new Array(links.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_DOWNLOADS, links.length);

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= links.length) return;

      const result = await checkLink(links[index]);
      results[index] = result;
      const label = result.status === "live" ? "SỐNG" : result.status === "dead" ? "ĐÃ CHẾT" : "CHƯA XÁC MINH";
      const colorCode = result.status === "live" ? COLOR.green : result.status === "dead" ? COLOR.red : COLOR.yellow;
      console.log(color(`  [${index + 1}/${links.length}] ${label}: ${shorten(result.url, 90)}`, colorCode));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    liveLinks: results.filter((result) => result.status === "live").map((result) => result.url),
    deadLinks: results.filter((result) => result.status === "dead").map((result) => result.url),
    unknownLinks: results.filter((result) => result.status === "unknown").map((result) => result.url),
  };
}

function downloadMedia(job, ffmpegDirectory, jobs) {
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
  const tempDirectory = path.join(TEMP_ROOT, activeMode.type);
  fs.mkdirSync(tempDirectory, { recursive: true });

  const args = [
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
    // Client mac dinh hien tai tra ve DASH bi YouTube 403 tren mot so mang.
    // Android tra ve stream HTTPS tuong thich, khong can aria2 tach ket noi.
    "--extractor-args", "youtube:player_client=android",
    "--js-runtimes", `deno:${DENO_EXE}`,
    "--ffmpeg-location", ffmpegDirectory,
    "--download-archive", archiveFile,
    ...mediaArgs,
    "--paths", activeMode.outputDir,
    "--paths", `temp:${tempDirectory}`,
    "--output", "%(title).200B [%(id)s].%(ext)s",
    job.url,
  ];

  return new Promise((resolve) => {
    job.status = "starting";
    scheduleRender(jobs);

    const child = spawn(YTDLP_EXE, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: YTDLP_ENV,
    });
    ACTIVE_DOWNLOADS.add(child);

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const errorLines = [];
    let settled = false;

    function handleAria2Progress(line) {
      const percentMatch = line.match(/\((\d{1,3})%\)/);
      if (!percentMatch || (!line.includes("DL:") && !line.includes("[#"))) return false;

      const speedMatch = line.match(/\bDL:([^\s\]]+)/);
      const etaMatch = line.match(/\bETA:([^\s\]]+)/);
      const sizeMatch = line.match(/([0-9.]+\s*[KMGT]i?B)\/([0-9.]+\s*[KMGT]i?B)\(/i);
      job.percent = Number(percentMatch[1]);
      job.speed = speedMatch ? speedMatch[1] : job.speed;
      job.eta = etaMatch ? etaMatch[1] : job.eta;
      if (sizeMatch) {
        job.downloadedSize = normalizeSizeLabel(sizeMatch[1]);
        job.totalSize = normalizeSizeLabel(sizeMatch[2]);
      }
      job.status = job.percent >= 99 ? "merging" : "downloading";
      scheduleRender(jobs);
      return true;
    }

    function handleOutputLine(rawLine) {
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) return;
      if (handleAria2Progress(line)) return;

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
      }
      scheduleRender(jobs);
    }

    function handleErrorLine(rawLine) {
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) return;
      if (handleAria2Progress(line)) return;
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

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      ACTIVE_DOWNLOADS.delete(child);
      job.status = "failed";
      job.error = error.message;
      scheduleRender(jobs);
      resolve(false);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      ACTIVE_DOWNLOADS.delete(child);
      if (stdoutBuffer) handleOutputLine(stdoutBuffer);
      if (stderrBuffer) handleErrorLine(stderrBuffer);

      if (code === 0) {
        job.status = "done";
        job.percent = 100;
        try {
          if (job.filePath && fs.existsSync(job.filePath)) {
            job.fileSizeBytes = fs.statSync(job.filePath).size;
          }
        } catch {
          job.fileSizeBytes = 0;
        }
      } else {
        job.status = "failed";
        job.error = errorLines.find((line) => line.includes("ERROR:"))
          || errorLines.at(-1)
          || `yt-dlp dừng với mã lỗi ${code}`;
      }
      scheduleRender(jobs);
      resolve(code === 0);
    });
  });
}

async function runSession() {
  const selectedMode = await chooseMode();
  let searchLinks = [];
  let searchQuery = "";
  let searchLimit = 0;
  if (selectedMode === YT_SEARCH_MODE) {
    activeMode = { ...await chooseSearchDownloadMode(), searchWithYtSearch: true };
    searchQuery = await askYouTubeSearchQuery();
    searchLimit = await askSearchResultLimit();
    searchLinks = await searchYouTube(searchQuery, searchLimit);
    if (searchLinks.length === 0) {
      console.log(color("yt-search không tìm thấy URL video YouTube.", COLOR.yellow));
      return chooseNextAction();
    }
    console.log(color(`yt-search đã tìm được ${searchLinks.length}/${searchLimit} URL YouTube. Đang kiểm tra link sống...`, COLOR.cyan));
  } else {
    activeMode = { ...selectedMode };
  }
  activeMode.outputDir = searchQuery
    ? createSearchOutputFolder(searchQuery)
    : await chooseOutputFolder();
  const savedLinks = readLinks(activeMode.linkFile, activeMode.searchWithYtSearch === true);
  if (savedLinks.length === 0 && searchLinks.length === 0) {
    console.log(color(`\nFile ${activeMode.linkFile} chưa có link. Thêm mỗi dòng một link YouTube rồi chạy lại.`, COLOR.yellow));
    return chooseNextAction();
  }

  fs.mkdirSync(activeMode.outputDir, { recursive: true });
  console.log(`Tìm thấy ${savedLinks.length} link có sẵn.`);
  console.log(`Thư mục lưu: ${activeMode.outputDir}`);
  console.log("Lần chạy đầu có thể mất vài phút để tải công cụ hỗ trợ.\n");

  const { ffmpegDirectory } = await ensureTools();
  const emptyValidation = { liveLinks: [], deadLinks: [], unknownLinks: [] };
  const searchValidation = searchLinks.length
    ? await validateLinks(searchLinks)
    : emptyValidation;
  if (searchLinks.length) {
    const searchLiveLinks = searchValidation.liveLinks;
    const addedCount = appendUniqueLinks(activeMode.linkFile, searchLiveLinks);
    console.log(color(`yt-search: ${searchLiveLinks.length} link sống, ${searchValidation.deadLinks.length} link chết, ${searchValidation.unknownLinks.length} link chưa xác minh. Đã lưu ${addedCount} link sống vào ${activeMode.linkFile}.`, searchLiveLinks.length ? COLOR.green : COLOR.yellow));
  }

  const savedLinksToValidate = activeMode.searchWithYtSearch
    ? []
    : savedLinks;
  const savedValidation = savedLinksToValidate.length
    ? await validateLinks(savedLinksToValidate)
    : emptyValidation;
  const liveLinks = activeMode.searchWithYtSearch
    ? searchValidation.liveLinks
    : savedValidation.liveLinks;
  const deadLinks = [...new Set([...searchValidation.deadLinks, ...savedValidation.deadLinks])];
  const unknownLinks = [...new Set([...searchValidation.unknownLinks, ...savedValidation.unknownLinks])];
  if (deadLinks.length) {
    console.log(color(`\nBỏ qua ${deadLinks.length} link đã chết.`, COLOR.red));
  }
  if (unknownLinks.length) {
    console.log(color(`${unknownLinks.length} link chưa xác minh được nên được giữ lại, không tải.`, COLOR.yellow));
  }

  if (liveLinks.length === 0) {
    const removedCount = removeLinksFromFile(activeMode.linkFile, new Set(deadLinks));
    if (removedCount) {
      console.log(color(`Đã xóa ${removedCount} link chết khỏi ${activeMode.linkFile}.`, COLOR.red));
    }
    console.log(color("Không có link sống để tải.", COLOR.yellow));
    const shouldContinue = await chooseNextAction();
    if (!shouldContinue) process.exitCode = unknownLinks.length ? 1 : 0;
    return shouldContinue;
  }

  const jobs = liveLinks.map((url) => ({
    url,
    title: url,
    status: "waiting",
    percent: 0,
    speed: "",
    eta: "",
    downloadedSize: "",
    totalSize: "",
    error: "",
    filePath: "",
    fileSizeBytes: 0,
  }));
  let succeeded = 0;
  let failed = 0;
  let nextIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_DOWNLOADS, liveLinks.length);

  renderDashboard(jobs, true);

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= liveLinks.length) return;

      const ok = await downloadMedia(
        jobs[currentIndex], 
        ffmpegDirectory,
        jobs,
      );
      if (ok) succeeded += 1;
      else failed += 1;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  renderDashboard(jobs, true);

  console.log(color("\nKẾT QUẢ CHI TIẾT", COLOR.bold + COLOR.cyan));
  for (const job of jobs) {
    if (job.status === "done") {
      const sizeText = job.fileSizeBytes ? ` (${formatMegabytes(job.fileSizeBytes)})` : "";
      console.log(color(`✔ ${job.title}${sizeText}`, COLOR.green));
      console.log(color(`  ${job.url}`, COLOR.dim));
    } else {
      console.log(color(`✖ ${job.title}`, COLOR.red));
      console.log(color(`  ${job.url}`, COLOR.red));
    }
  }
  const totalDownloadedBytes = jobs.reduce((sum, job) => sum + (job.fileSizeBytes || 0), 0);
  console.log(color(`\nHoàn tất: ${succeeded}   Lỗi: ${failed}`, failed ? COLOR.yellow : COLOR.green));
  if (totalDownloadedBytes) {
    console.log(color(`Tổng dung lượng: ${formatMegabytes(totalDownloadedBytes)}`, COLOR.magenta));
  }
  console.log(color(`${activeMode.mediaName} nằm tại: ${activeMode.outputDir}`, COLOR.blue));
  const urlsToRemove = new Set([
    ...deadLinks,
    ...jobs.filter((job) => job.status === "done").map((job) => job.url),
  ]);
  const removedCount = removeLinksFromFile(activeMode.linkFile, urlsToRemove);
  if (removedCount) {
    console.log(color(`Đã xóa ${removedCount} link chết hoặc tải thành công khỏi ${activeMode.linkFile}.`, COLOR.green));
  }
  const shouldContinue = await chooseNextAction();
  if (!shouldContinue) process.exitCode = failed > 0 ? 1 : 0;
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
  const folder = commandOption("--folder");
  const requestedOutputDirectory = commandOption("--output-dir");
  if (!Object.hasOwn(MODES, mode)) throw new Error("Chế độ tải không hợp lệ.");

  const outputRoot = path.resolve(OUTPUT_ROOT);
  let outputDirectory;
  if (requestedOutputDirectory) {
    outputDirectory = path.resolve(requestedOutputDirectory);
  } else {
    if (!folder || folder !== path.basename(folder)) throw new Error("Thư mục lưu không hợp lệ.");
    outputDirectory = path.resolve(outputRoot, folder);
  }
  if (!outputDirectory.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("Thư mục lưu không hợp lệ.");
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (!fs.statSync(outputDirectory).isDirectory()) throw new Error("Đường dẫn lưu không phải là thư mục.");

  activeMode = { ...MODES[mode], outputDir: outputDirectory };
  const savedLinks = readLinks(activeMode.linkFile, true);
  if (savedLinks.length === 0) {
    desktopEvent("complete", { failed: 0, message: "Chưa có link để tải." });
    return;
  }

  desktopEvent("status", { message: `Đang chuẩn bị ${savedLinks.length} link...` });
  const { ffmpegDirectory } = await ensureTools();
  const { liveLinks, deadLinks, unknownLinks } = await validateLinks(savedLinks);
  if (liveLinks.length === 0) {
    const removedCount = removeLinksFromFile(activeMode.linkFile, new Set(deadLinks));
    desktopEvent("complete", {
      failed: unknownLinks.length,
      message: removedCount
        ? `Không có link sống. Đã xóa ${removedCount} link chết khỏi danh sách.`
        : "Không có link sống để tải.",
    });
    return;
  }

  const jobs = liveLinks.map((url) => ({
    url,
    title: url,
    status: "waiting",
    percent: 0,
    speed: "",
    eta: "",
    downloadedSize: "",
    totalSize: "",
    error: "",
    filePath: "",
    fileSizeBytes: 0,
  }));
  let succeeded = 0;
  let failed = 0;
  let nextIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_DOWNLOADS, liveLinks.length);
  renderDashboard(jobs, true);

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= liveLinks.length) return;
      const ok = await downloadMedia(jobs[currentIndex], ffmpegDirectory, jobs);
      if (ok) succeeded += 1;
      else failed += 1;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  renderDashboard(jobs, true);
  const urlsToRemove = new Set([
    ...deadLinks,
    ...jobs.filter((job) => job.status === "done").map((job) => job.url),
  ]);
  const removedCount = removeLinksFromFile(activeMode.linkFile, urlsToRemove);
  desktopEvent("complete", {
    failed,
    succeeded,
    message: `Hoàn tất: ${succeeded} thành công, ${failed} lỗi.${removedCount ? ` Đã xóa ${removedCount} link đã xong hoặc đã chết.` : ""}`,
  });
  process.exitCode = failed > 0 ? 1 : 0;
}

(DESKTOP_MODE ? runDesktopSession() : main()).catch((error) => {
  desktopEvent("error", { message: error.message });
  console.error(`\nLOI: ${error.message}`);
  process.exitCode = 1;
});
