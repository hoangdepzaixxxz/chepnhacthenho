let state = {
  videoLinks: "",
  audioLinks: "",
  outputDirectory: "",
  version: "",
  update: { available: false, message: "" },
};
let mode = "video";
let runMode = null; // the list being downloaded, which may differ from the open tab
let running = false;
let jobs = [];
let lastQuery = "";
let searchResults = [];
let linksSync = null; // pending reload of the link files after a run

const $ = (id) => document.getElementById(id);
const linksKey = (linkMode) => (linkMode === "video" ? "videoLinks" : "audioLinks");
const MODE_NAMES = { video: "Video", audio: "MP3" };
const FORMAT_NOTES = { video: "MP4 · H.264 · tối đa 720p", audio: "MP3 · chất lượng cao nhất" };

function readableError(error) {
  return String(error?.message || error || "Đã xảy ra lỗi.")
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function folderName(directory) {
  return String(directory || "").split(/[/\\]/).filter(Boolean).pop() || "";
}

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */
const TOAST_ICONS = {
  ready: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M20 6 9 17l-5-5"></path></svg>',
  error: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4M12 16h.01"></path></svg>',
  subdued: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9"></circle><path d="M12 16v-4M12 8h.01"></path></svg>',
};

function showToast(message, type = "subdued") {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.subdued;
  const text = document.createElement("span");
  text.className = "toast-msg";
  // Messages can contain video titles and error text: never parse them as HTML.
  text.textContent = message;
  toast.append(icon, text);
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

function setStatus(text, type = "subdued", { toast = true } = {}) {
  const cleanText = type === "error" ? readableError(text) : String(text || "");
  const el = $("update-status");
  if (el) {
    el.textContent = cleanText;
    el.className = `status ${type}`;
  }
  if (toast) showToast(cleanText, type);
}

/* --------------------------------------------------------------------------
   Link lists
   -------------------------------------------------------------------------- */
function linkLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function countLinks(text) {
  return linkLines(text).filter((line) => !line.startsWith("#")).length;
}

// The open tab's list is the textarea (it may hold unsaved edits); the other is the saved copy.
function linksFor(linkMode) {
  return linkMode === mode ? $("links")?.value || "" : state[linksKey(linkMode)] || "";
}

function renderCounts() {
  const count = countLinks(linksFor(mode));
  setText($("link-count"), `${count} link`);
  setText($("count-video"), String(countLinks(linksFor("video"))));
  setText($("count-audio"), String(countLinks(linksFor("audio"))));
  renderSummary();
  if (!jobs.length) renderJobs();
}

// Saves the textarea for the open tab. Only the Save button shows a toast; automatic
// saves (switching tabs, starting a download) stay quiet.
async function saveLinks({ notify = false } = {}) {
  if (linksSync) await linksSync;
  const linksValue = $("links")?.value || "";
  await window.downloader.saveLinks({ mode, contents: linksValue });
  state[linksKey(mode)] = linksValue;
  if (notify) setStatus("Đã lưu danh sách link.", "ready");
}

// The runner removes finished and dead links from the link file. Load that result and
// keep any edits made in the textarea while the download was running.
async function reloadLinksAfterRun() {
  const latest = await window.downloader.state();
  const key = linksKey(mode);
  const textarea = $("links");
  const before = new Set(linkLines(state[key]));
  const edited = linkLines(textarea?.value);
  const editedSet = new Set(edited);
  const latestLines = linkLines(latest[key]);
  const kept = latestLines.filter((line) => !before.has(line) || editedSet.has(line));
  const keptSet = new Set(kept);
  const added = edited.filter((line) => !before.has(line) && !keptSet.has(line));
  const merged = [...kept, ...added];

  state.videoLinks = latest.videoLinks;
  state.audioLinks = latest.audioLinks;
  // Leave the textarea (and its caret) alone when nothing in it changed.
  if (textarea && merged.join("\n") !== edited.join("\n")) textarea.value = merged.join("\n");
  if (added.length || kept.length !== latestLines.length) {
    await window.downloader.saveLinks({ mode, contents: textarea?.value || "" });
    state[key] = textarea?.value || "";
  }
  renderCounts();
}

function syncLinksAfterRun() {
  if (linksSync) return linksSync;
  linksSync = reloadLinksAfterRun()
    .catch((error) => setStatus(error, "error"))
    .finally(() => { linksSync = null; });
  return linksSync;
}

/* --------------------------------------------------------------------------
   Title row and tabs
   -------------------------------------------------------------------------- */
function jobCounts() {
  const counts = { done: 0, failed: 0, active: 0, waiting: 0 };
  for (const job of jobs) {
    if (job.status === "done") counts.done += 1;
    else if (job.status === "failed") counts.failed += 1;
    else if (job.status === "waiting") counts.waiting += 1;
    else counts.active += 1;
  }
  return counts;
}

// The line under the title: what is queued, or how far the run is. The destination
// follows it as its own control.
function renderSummary() {
  let text;
  if (running && jobs.length) {
    const { done, failed } = jobCounts();
    text = `Đang tải ${MODE_NAMES[runMode]} · ${done}/${jobs.length} bài xong${failed ? ` · ${failed} lỗi` : ""}`;
  } else if (running) {
    text = `Đang chuẩn bị tải ${MODE_NAMES[runMode]}`;
  } else {
    const count = countLinks(linksFor(mode));
    text = count
      ? `${count} link ${MODE_NAMES[mode]} chờ tải`
      : `Chưa có link ${MODE_NAMES[mode]} nào`;
  }
  setText($("page-sub"), text);
}

function switchMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  });
  const linksEl = $("links");
  if (linksEl) linksEl.value = state[linksKey(mode)] || "";
  setText($("format-note"), FORMAT_NOTES[mode]);
  setText($("links-title"), `Link ${MODE_NAMES[mode]} chờ tải`);
  renderAddButton();
  renderCounts();
}

function renderOutputDirectory(directory) {
  setText($("output-name"), folderName(directory) || "Chọn thư mục");
  const chooser = $("choose-output-directory");
  if (chooser) chooser.title = directory ? `${directory}
Bấm để đổi thư mục lưu` : "Chọn thư mục lưu";
  renderSummary();
  renderProgress();
}

/* --------------------------------------------------------------------------
   Progress: the figure, the song strip and one row per song
   -------------------------------------------------------------------------- */
const JOB_LABELS = {
  waiting: "Chờ",
  starting: "Khởi tạo",
  downloading: "Đang tải",
  done: "Xong",
  failed: "Lỗi",
};
const jobRows = new Map();

function jobLabel(job) {
  if (job.status === "merging") return runMode === "audio" ? "Đang chuyển MP3" : "Đang ghép";
  return JOB_LABELS[job.status] || "Chờ";
}

function createJobRow() {
  const item = document.createElement("li");
  const title = document.createElement("span");
  title.className = "job-title";
  const meta = document.createElement("span");
  meta.className = "job-meta";
  const speed = document.createElement("span");
  speed.className = "job-speed num";
  const figure = document.createElement("span");
  figure.className = "job-figure num";
  const pill = document.createElement("span");
  pill.className = "pill";
  meta.append(speed, figure, pill);
  const bar = document.createElement("span");
  bar.className = "job-bar";
  const fill = document.createElement("i");
  bar.append(fill);
  const error = document.createElement("span");
  error.className = "job-error";
  item.append(title, meta, bar, error);
  return { item, title, speed, figure, pill, fill, error };
}

function updateJobRow(row, job) {
  const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
  const active = ["starting", "downloading", "merging"].includes(job.status);
  const className = `job ${job.status || "waiting"}`;
  if (row.item.className !== className) row.item.className = className;
  const titleText = job.title || job.url || "Đang chuẩn bị…";
  setText(row.title, titleText);
  if (row.title.title !== titleText) row.title.title = titleText;
  setText(row.speed, active && job.speed ? job.speed.replace(/iB\/s$/, "B/s") : "");
  setText(row.figure, active ? `${percent.toFixed(job.status === "merging" ? 0 : 1)}%` : "");
  const pillClass = `pill ${job.status || "waiting"}`;
  if (row.pill.className !== pillClass) row.pill.className = pillClass;
  setText(row.pill, jobLabel(job));
  const width = `${percent}%`;
  if (row.fill.style.width !== width) row.fill.style.width = width;
  setText(row.error, job.status === "failed" ? job.error || "Không tải được bài này." : "");
  row.error.hidden = job.status !== "failed";
}

// One cell per song; a song's cell fills as it downloads. Before a run, the cells
// are the links waiting in the open list.
function renderStrip() {
  const strip = $("strip");
  if (!strip) return;
  const cells = jobs.length
    ? jobs.map((job) => ({ status: job.status, percent: Number(job.percent) || 0 }))
    : Array.from({ length: Math.min(countLinks(linksFor(mode)), 200) }, () => ({ status: "waiting", percent: 0 }));
  while (strip.children.length > cells.length) strip.lastChild.remove();
  while (strip.children.length < cells.length) {
    const cell = document.createElement("span");
    cell.append(document.createElement("i"));
    strip.append(cell);
  }
  strip.classList.toggle("dense", cells.length > 40);
  cells.forEach((cell, index) => {
    const el = strip.children[index];
    const className = `cell ${cell.status}`;
    if (el.className !== className) el.className = className;
    const width = cell.status === "done" ? "100%" : `${Math.max(0, Math.min(100, cell.percent))}%`;
    if (el.firstChild.style.width !== width) el.firstChild.style.width = width;
  });
}

function renderProgress() {
  const { done, failed, active, waiting } = jobCounts();
  const total = jobs.length || countLinks(linksFor(mode));
  setText($("progress-figure"), `${jobs.length ? done : 0} / ${total}`);
  const notes = [];
  if (active) notes.push(`${active} đang tải`);
  if (waiting && jobs.length) notes.push(`${waiting} chờ`);
  if (failed) notes.push(`${failed} lỗi`);
  setText($("progress-note"), notes.join(" · "));
  renderStrip();

  // With links queued, their rows are the content; the guide shows only for an empty list.
  const count = countLinks(linksFor(mode));
  const empty = $("empty-progress");
  if (empty) empty.hidden = jobs.length > 0 || running || count > 0;
  setText($("empty-mode"), MODE_NAMES[mode]);
  if ($("start")) $("start").disabled = running || count === 0;
}

const QUEUE_PREVIEW_ROWS = 12;

// Before a run, the list shows the links waiting to be downloaded, so the same rows
// fill in once the run starts.
function queuedRows() {
  return linkLines(linksFor(mode))
    .filter((line) => !line.startsWith("#"))
    .slice(0, QUEUE_PREVIEW_ROWS)
    .map((url) => ({ url, title: url.replace(/^https?:\/\/(www\.)?/i, ""), status: "queued", percent: 0 }));
}

function renderJobs() {
  const container = $("jobs");
  if (!container) return;
  const rows = jobs.length || running ? jobs : queuedRows();
  const items = rows.map((job) => {
    let row = jobRows.get(job.url);
    if (!row) {
      row = createJobRow();
      jobRows.set(job.url, row);
    }
    updateJobRow(row, job);
    return row.item;
  });
  const current = new Set(rows.map((job) => job.url));
  for (const url of jobRows.keys()) {
    if (!current.has(url)) jobRows.delete(url);
  }
  const children = container.children;
  const hidden = rows === jobs ? 0 : countLinks(linksFor(mode)) - items.length;
  const more = $("jobs-more");
  if (more) {
    more.hidden = hidden <= 0;
    setText(more, `và ${hidden} link nữa trong danh sách`);
  }
  if (children.length !== items.length || items.some((item, index) => children[index] !== item)) {
    container.replaceChildren(...items);
  }
  renderProgress();
}

/* --------------------------------------------------------------------------
   YouTube search
   -------------------------------------------------------------------------- */
const AGO_UNITS = [
  [/^(s|secs?|seconds?)$/, "giây"],
  [/^(m|mins?|minutes?)$/, "phút"],
  [/^(h|hrs?|hours?)$/, "giờ"],
  [/^(d|days?)$/, "ngày"],
  [/^(w|wks?|weeks?)$/, "tuần"],
  [/^(mo|mos|months?)$/, "tháng"],
  [/^(y|yrs?|years?)$/, "năm"],
];

// "6 months ago" / "2mo ago" / "Streamed 5h ago" → "6 tháng trước"
function formatAgo(ago) {
  const text = String(ago || "").trim();
  const match = text.toLowerCase().match(/(\d+)\s*([a-z]+)\s+ago/);
  const unit = match && AGO_UNITS.find(([pattern]) => pattern.test(match[2]));
  return unit ? `${match[1]} ${unit[1]} trước` : text;
}

function selectedResults() {
  return [...document.querySelectorAll("#search-results input:checked")]
    .map((input) => searchResults[Number(input.dataset.index)])
    .filter(Boolean);
}

function renderAddButton() {
  const count = selectedResults().length;
  const button = $("add-search");
  if (!button) return;
  button.disabled = count === 0;
  setText(button, count ? `Thêm ${count} bài` : "Chọn bài để thêm");
  const full = count ? `Thêm ${count} bài vào danh sách ${MODE_NAMES[mode]}` : "Chọn bài để thêm";
  button.title = full;
  // The destination follows the open tab, so it is restated whenever the tab changes.
  setText($("search-count"), `${searchResults.length} video, mới đăng xếp trước · thêm vào ${MODE_NAMES[mode]}`);
  button.setAttribute("aria-label", full);
  const all = document.querySelectorAll("#search-results input").length;
  const selectAll = $("select-all");
  if (selectAll) {
    selectAll.checked = all > 0 && count === all;
    selectAll.indeterminate = count > 0 && count < all;
  }
}

function renderSearchResults() {
  const panel = $("search-panel");
  const container = $("search-results");
  if (!panel || !container) return;
  const open = searchResults.length > 0 || Boolean(lastQuery);
  panel.hidden = !open;
  if ($("links-panel")) $("links-panel").hidden = open;
  setText($("search-title"), lastQuery ? `Kết quả cho “${lastQuery}”` : "Kết quả tìm kiếm");

  container.replaceChildren(...searchResults.map((video, index) => {
    const row = document.createElement("label");
    row.className = "result";
    row.setAttribute("role", "listitem");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.dataset.index = String(index);
    check.setAttribute("aria-label", video.title);

    const thumb = document.createElement("img");
    thumb.className = "result-thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    if (video.thumbnail) thumb.src = video.thumbnail;

    const copy = document.createElement("span");
    copy.className = "result-copy";
    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = video.title;
    title.title = video.title;
    const author = document.createElement("span");
    author.className = "result-author";
    // The age leads: the list is sorted newest first.
    author.textContent = [formatAgo(video.ago), video.author].filter(Boolean).join(" · ") || "—";
    copy.append(title, author);

    const duration = document.createElement("span");
    duration.className = "result-duration num";
    duration.textContent = video.duration || "—";

    row.append(check, thumb, copy, duration);
    return row;
  }));
  renderAddButton();
}

async function runSearch(query) {
  const button = $("search");
  if (!query) {
    setStatus("Hãy nhập tên bài hát hoặc ca sĩ cần tìm.", "error");
    $("search-query")?.focus();
    return;
  }
  button.disabled = true;
  setText(button, "Đang tìm…");
  try {
    searchResults = await window.downloader.searchYoutube({
      query,
      limit: Number($("search-limit")?.value || 20),
    });
    lastQuery = query;
    renderSearchResults();
    setStatus(
      searchResults.length ? `Tìm thấy ${searchResults.length} video cho “${query}”.` : `Không tìm thấy video nào cho “${query}”.`,
      searchResults.length ? "ready" : "subdued",
      { toast: !searchResults.length },
    );
  } catch (error) {
    setStatus(error, "error");
  } finally {
    button.disabled = false;
    setText(button, "Tìm");
  }
}

/* --------------------------------------------------------------------------
   Theme
   -------------------------------------------------------------------------- */
function storedTheme() {
  try {
    return localStorage.getItem("app-theme");
  } catch {
    return null;
  }
}

function setTheme(nextTheme) {
  document.documentElement.setAttribute("data-theme", nextTheme);
  try {
    localStorage.setItem("app-theme", nextTheme);
  } catch {
    // The theme still applies for this session.
  }
  window.downloader?.setTheme?.(nextTheme).catch(() => {});
}

/* --------------------------------------------------------------------------
   Initialisation
   -------------------------------------------------------------------------- */
async function initialize() {
  setTheme(storedTheme() === "light" ? "light" : "dark");
  state = await window.downloader.state();
  setText($("app-version"), state.version ? `v${state.version}` : "");
  switchMode("video");
  renderOutputDirectory(state.outputDirectory);
  setStatus(
    state.update?.available ? `Phiên bản v${state.version}. Sẵn sàng kiểm tra bản mới.` : `Phiên bản v${state.version}.`,
    "subdued",
    { toast: false },
  );
}

/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */
window.addEventListener("scroll", () => {
  $("topbar")?.classList.toggle("scrolled", window.scrollY > 0);
}, { passive: true });

$("theme-toggle")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  setTheme(current === "dark" ? "light" : "dark");
});

$("links")?.addEventListener("input", renderCounts);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    if (tab.dataset.mode === mode) return;
    try {
      await saveLinks();
      switchMode(tab.dataset.mode);
    } catch (error) {
      setStatus(error, "error");
    }
  });
});

$("save-links")?.addEventListener("click", () => {
  saveLinks({ notify: true }).catch((error) => setStatus(error, "error"));
});

$("btn-clear-links")?.addEventListener("click", async () => {
  if (!$("links").value.trim()) return;
  if (!confirm(`Xoá toàn bộ link ${MODE_NAMES[mode]} trong danh sách?`)) return;
  try {
    $("links").value = "";
    renderCounts();
    await saveLinks();
    setStatus(`Đã xoá danh sách link ${MODE_NAMES[mode]}.`, "subdued");
  } catch (error) {
    setStatus(error, "error");
  }
});

$("search-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch($("search-query")?.value?.trim());
});

$("search-limit")?.addEventListener("change", () => {
  if (lastQuery) runSearch(lastQuery);
});

$("search-results")?.addEventListener("change", renderAddButton);

$("select-all")?.addEventListener("change", (event) => {
  const checked = event.target.checked;
  document.querySelectorAll("#search-results input[type='checkbox']").forEach((cb) => (cb.checked = checked));
  renderAddButton();
});

function closeSearch() {
  searchResults = [];
  lastQuery = "";
  renderSearchResults();
}

$("search-close")?.addEventListener("click", closeSearch);

// Esc closes the results and brings the link list back.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("search-panel")?.hidden) closeSearch();
});

$("add-search")?.addEventListener("click", async () => {
  try {
    const selected = selectedResults().map((video) => video.url);
    if (!selected.length) return;
    const currentText = $("links")?.value || "";
    const existing = new Set(linkLines(currentText));
    const newUrls = selected.filter((url) => !existing.has(url));
    $("links").value = [currentText.trim(), ...newUrls].filter(Boolean).join("\n");
    renderCounts();
    await saveLinks();
    closeSearch();
    setStatus(
      newUrls.length
        ? `Đã thêm ${newUrls.length} bài vào danh sách ${MODE_NAMES[mode]}.`
        : "Các bài đã chọn đều có sẵn trong danh sách.",
      "ready",
    );
  } catch (error) {
    setStatus(error, "error");
  }
});

$("empty-search")?.addEventListener("click", () => $("search-query")?.focus());
$("empty-paste")?.addEventListener("click", () => $("links")?.focus());

function openOutputFolder() {
  window.downloader.openOutput().catch((error) => setStatus(error, "error"));
}
$("open-output")?.addEventListener("click", openOutputFolder);

$("choose-output-directory")?.addEventListener("click", async () => {
  try {
    const directory = await window.downloader.chooseOutputDirectory();
    state.outputDirectory = directory;
    renderOutputDirectory(directory);
    setStatus(`Sẽ lưu vào ${folderName(directory)}.`, "ready");
  } catch (error) {
    setStatus(error, "error");
  }
});

function setRunning(isRunning) {
  running = isRunning;
  if ($("stop")) $("stop").disabled = !isRunning;
  renderJobs();
  renderSummary();
}

$("start")?.addEventListener("click", async () => {
  try {
    await saveLinks();
    jobs = [];
    runMode = mode;
    renderJobs();
    setText($("progress-heading"), "Đang chuẩn bị…");
    setRunning(true);
    await window.downloader.start({ mode, outputDirectory: state.outputDirectory || "" });
  } catch (error) {
    setRunning(false);
    setStatus(error, "error");
  }
});

$("stop")?.addEventListener("click", () => {
  if ($("stop")) $("stop").disabled = true;
  window.downloader.stop().catch((error) => setStatus(error, "error"));
  setStatus("Đang dừng… các bài đã tải xong vẫn được giữ lại.", "subdued");
});

$("update")?.addEventListener("click", async () => {
  try {
    const result = await window.downloader.checkUpdate();
    if (result?.text) setStatus(result.text, result.state === "unconfigured" ? "error" : "subdued");
    if (result?.state === "unconfigured") await window.downloader.showUpdateHelp();
  } catch (error) {
    setStatus(error, "error");
  }
});

$("author-zalo-btn")?.addEventListener("click", () => {
  window.downloader?.openExternal?.("https://zalo.me/sadboyyzz");
});

/* Runner events */
let completed = false;
window.downloader.onDownload((event) => {
  if (event.type === "status") {
    setText($("progress-heading"), event.message || "Đang xử lý…");
  }
  if (event.type === "jobs") {
    jobs = event.jobs || [];
    setText($("progress-heading"), "Đang tải");
    renderJobs();
    renderSummary();
  }
  if (event.type === "complete") {
    completed = true;
    const heading = event.stopped ? "Đã dừng" : event.failed ? "Xong, có bài lỗi" : "Đã tải xong";
    setText($("progress-heading"), heading);
    setStatus(event.message, event.failed ? "error" : event.stopped ? "subdued" : "ready");
    // The runner has already updated the link file: reload it before anything can save over it.
    syncLinksAfterRun();
  }
  if (event.type === "error") {
    setStatus(event.message, "error");
  }
  if (event.type === "runner-closed") {
    setRunning(false);
    if (!completed) syncLinksAfterRun();
    completed = false;
  }
});

// Progress ticks while an update downloads only refresh the status line;
// a toast per tick would stack dozens of them.
const QUIET_UPDATE_STATES = new Set(["checking", "downloading"]);
window.downloader.onUpdate((event) => {
  const type = event.state === "error" ? "error" : event.state === "ready" ? "ready" : "subdued";
  setStatus(event.text, type, { toast: !QUIET_UPDATE_STATES.has(event.state) });
});

initialize().catch((error) => setStatus(error, "error"));
