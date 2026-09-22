let state = {
  videoLinks: "",
  audioLinks: "",
  outputDirectory: "",
  version: "1.4.0",
  update: { available: false, message: "" },
};
let mode = "video";
let jobs = [];
let running = false;
let searchResults = [];

const $ = (id) => document.getElementById(id);

function readableError(error) {
  return String(error?.message || error || "Đã xảy ra lỗi.")
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

/* --------------------------------------------------------------------------
   Toast Notification System
   -------------------------------------------------------------------------- */
function showToast(message, type = "subdued") {
  const container = $("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const iconSvg =
    type === "ready"
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
      : type === "error"
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
      : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

  toast.innerHTML = `
    <div class="toast-icon">${iconSvg}</div>
    <span class="toast-msg">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function countLinks(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;
}

function updateLinkCount() {
  const linksEl = $("links");
  const count = linksEl ? countLinks(linksEl.value) : 0;
  
  if ($("link-count")) $("link-count").textContent = `${count} link`;
  if ($("stat-links")) $("stat-links").textContent = `${count} liên kết`;
  if ($("nav-link-badge")) $("nav-link-badge").textContent = String(count);
}

function setStatus(text, type = "subdued") {
  const el = $("update-status");
  const cleanText = type === "error" ? readableError(text) : text;
  if (el) {
    el.textContent = cleanText;
    el.className = `status ${type}`;
  }
  showToast(cleanText, type);
}

function renderOutputDirectory(directory) {
  const cleanDir = directory || "Chưa chọn thư mục";
  if ($("output-directory")) {
    $("output-directory").textContent = cleanDir;
    $("output-directory").title = cleanDir;
  }
  if ($("output-root")) {
    $("output-root").textContent = cleanDir;
  }

  const folderName = cleanDir.split(/[/\\]/).filter(Boolean).pop() || cleanDir;
  if ($("stat-folder")) $("stat-folder").textContent = folderName;
  if ($("sidebar-folder-path")) {
    $("sidebar-folder-path").textContent = folderName;
    $("sidebar-folder-path").title = cleanDir;
  }
}

function switchMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  
  const linksEl = $("links");
  if (linksEl && state) {
    linksEl.value = mode === "video" ? (state.videoLinks || "") : (state.audioLinks || "");
  }

  if ($("stat-mode")) {
    $("stat-mode").textContent = mode === "video" ? "Video 720p HD" : "Voice MP3 HQ";
  }

  updateLinkCount();
}

function renderJobs() {
  const emptyEl = $("empty-progress");
  if (emptyEl) emptyEl.hidden = jobs.length > 0;

  const jobsContainer = $("jobs");
  if (!jobsContainer) return;

  jobsContainer.replaceChildren(...jobs.map((job) => {
    const item = document.createElement("article");
    item.className = `job ${job.status || ""}`;
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));

    item.innerHTML = `
      <div class="job-row">
        <span class="job-title" title="${job.title || job.url || ""}"></span>
        <span class="job-meta"></span>
      </div>
      <div class="bar"><i></i></div>
    `;

    item.querySelector(".job-title").textContent = job.title || job.url || "Đang chuẩn bị tải...";
    item.querySelector(".job-meta").textContent =
      job.status === "failed"
        ? (job.error || "Lỗi tải")
        : `${percent.toFixed(1)}%${job.speed ? ` · ${job.speed}` : ""}`;
    item.querySelector("i").style.width = `${percent}%`;

    return item;
  }));

  const summaryText = $("summary")?.textContent || "0 / 0";
  if ($("nav-progress-badge")) $("nav-progress-badge").textContent = summaryText;
  if ($("stat-progress")) $("stat-progress").textContent = `${summaryText} bài`;
}

function renderSearchResults() {
  const container = $("search-results");
  const actionsRow = $("add-search-row");
  if (!container || !actionsRow) return;

  container.hidden = searchResults.length === 0;
  actionsRow.hidden = searchResults.length === 0;

  if ($("search-count")) {
    $("search-count").textContent = `${searchResults.length} kết quả tìm thấy`;
  }

  container.replaceChildren(...searchResults.map((video, index) => {
    const row = document.createElement("label");
    row.className = "search-result";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.dataset.index = String(index);

    const copy = document.createElement("span");
    copy.className = "result-copy";

    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = video.title;

    const meta = document.createElement("span");
    meta.className = "result-meta";
    meta.textContent = [video.author, video.ago, video.duration].filter(Boolean).join(" · ");

    copy.append(title, meta);
    row.append(check, copy);
    return row;
  }));
}

async function saveLinks() {
  const linksValue = $("links") ? $("links").value : "";
  await window.downloader.saveLinks({ mode, contents: linksValue });
  if (state) {
    state[mode === "video" ? "videoLinks" : "audioLinks"] = linksValue;
  }
  setStatus("Đã lưu danh sách liên kết.", "ready");
}

/* --------------------------------------------------------------------------
   Theme Support (Dark / Light)
   -------------------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem("app-theme");
  const initialTheme = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  setTheme(initialTheme);
}

function setTheme(nextTheme) {
  document.documentElement.setAttribute("data-theme", nextTheme);
  localStorage.setItem("app-theme", nextTheme);
  const toggleBtn = $("theme-toggle");
  if (toggleBtn) {
    toggleBtn.setAttribute("title", nextTheme === "dark" ? "Chuyển sang giao diện Sáng" : "Chuyển sang giao diện Tối");
  }
  window.downloader?.setTheme?.(nextTheme).catch(() => {});
}

/* --------------------------------------------------------------------------
   Sidebar Navigation Scroll Spy
   -------------------------------------------------------------------------- */
function setupSidebarNavigation() {
  const navLinks = document.querySelectorAll(".nav-link[data-target]");
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");

      const targetId = link.dataset.target;
      const targetElement = $(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
        targetElement.classList.add("highlight-pulse");
        setTimeout(() => targetElement.classList.remove("highlight-pulse"), 1200);
      }
    });
  });
}

/* --------------------------------------------------------------------------
   App Initialization
   -------------------------------------------------------------------------- */
async function initialize() {
  initTheme();
  setupSidebarNavigation();

  state = await window.downloader.state();
  renderOutputDirectory(state.outputDirectory);
  switchMode("video");

  const statusMsg = state.update?.available
    ? `Phiên bản v${state.version}. Sẵn sàng kiểm tra bản mới.`
    : `Phiên bản v${state.version}. ${state.update?.message || "Hệ thống sẵn sàng."}`;
  setStatus(statusMsg, "subdued");
}

/* --------------------------------------------------------------------------
   Event Listeners
   -------------------------------------------------------------------------- */
$("theme-toggle")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
});

$("links")?.addEventListener("input", updateLinkCount);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    try {
      await saveLinks();
      switchMode(tab.dataset.mode);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
});

$("save-links")?.addEventListener("click", () => {
  saveLinks().catch((error) => setStatus(error.message, "error"));
});

/* YouTube Search */
$("search")?.addEventListener("click", async () => {
  const button = $("search");
  const query = $("search-query")?.value?.trim();
  if (!query) {
    setStatus("Hãy nhập từ khóa hoặc tên bài hát cần tìm.", "error");
    return;
  }

  try {
    button.disabled = true;
    button.innerHTML = `
      <svg class="spin-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"></line>
        <line x1="12" y1="18" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="6" y2="12"></line>
        <line x1="18" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
      </svg>
      <span>Đang tìm...</span>
    `;

    searchResults = await window.downloader.searchYoutube({
      query: query,
      limit: Number($("search-limit")?.value || 20),
    });

    renderSearchResults();
    setStatus(
      searchResults.length
        ? `Đã tìm thấy ${searchResults.length} video phù hợp trên YouTube.`
        : "Không tìm thấy video nào.",
      searchResults.length ? "ready" : "subdued"
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <span>Tìm kiếm</span>
    `;
  }
});

$("search-query")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("search")?.click();
});

/* Toggle all search checkboxes */
$("btn-toggle-all-search")?.addEventListener("click", () => {
  const checkboxes = document.querySelectorAll("#search-results input[type='checkbox']");
  if (!checkboxes.length) return;
  const anyChecked = [...checkboxes].some((cb) => cb.checked);
  checkboxes.forEach((cb) => (cb.checked = !anyChecked));
  $("btn-toggle-all-search").textContent = anyChecked ? "Chọn tất cả" : "Bỏ chọn tất cả";
});

/* Add selected search items to link textarea */
$("add-search")?.addEventListener("click", async () => {
  try {
    const selected = [...document.querySelectorAll("#search-results input:checked")]
      .map((input) => searchResults[Number(input.dataset.index)]?.url)
      .filter(Boolean);

    if (!selected.length) {
      setStatus("Hãy chọn ít nhất một video trong danh sách kết quả.", "error");
      return;
    }

    const currentText = $("links")?.value || "";
    const existing = new Set(currentText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    const newUrls = selected.filter((url) => !existing.has(url));

    $("links").value = [currentText.trim(), ...newUrls].filter(Boolean).join("\n");
    updateLinkCount();
    await saveLinks();

    setStatus(
      newUrls.length
        ? `Đã thêm ${newUrls.length} liên kết vào danh sách ${mode === "video" ? "Video" : "MP3"}.`
        : "Các liên kết đã chọn đều đã có sẵn trong danh sách.",
      "ready"
    );
  } catch (error) {
    setStatus(error.message, "error");
  }
});

/* Editor Helper Actions */
$("btn-clear-links")?.addEventListener("click", async () => {
  if (!$("links").value.trim()) return;
  if (confirm("Bạn có chắc chắn muốn xóa toàn bộ liên kết hiện tại?")) {
    $("links").value = "";
    updateLinkCount();
    await saveLinks();
    setStatus("Đã làm trống danh sách liên kết.", "subdued");
  }
});

/* Folder and Output Directory Actions */
$("open-output")?.addEventListener("click", () => {
  window.downloader.openOutput().catch((error) => setStatus(error.message, "error"));
});

$("sidebar-open-folder")?.addEventListener("click", () => {
  window.downloader.openOutput().catch((error) => setStatus(error.message, "error"));
});

$("choose-output-directory")?.addEventListener("click", async () => {
  try {
    const directory = await window.downloader.chooseOutputDirectory();
    state.outputDirectory = directory;
    renderOutputDirectory(directory);
    setStatus("Đã cập nhật thư mục lưu trữ file.", "ready");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

/* Download Execution Control */
$("start")?.addEventListener("click", async () => {
  try {
    await saveLinks();
    jobs = [];
    renderJobs();
    running = true;
    $("start").disabled = true;
    $("stop").disabled = false;
    $("progress-heading").textContent = "Đang kết nối yt-dlp & chuẩn bị tải...";
    
    // Smooth scroll to progress monitor section
    $("section-progress")?.scrollIntoView({ behavior: "smooth", block: "nearest" });

    await window.downloader.start({ mode, outputDirectory: state.outputDirectory || "" });
  } catch (error) {
    running = false;
    $("stop").disabled = true;
    $("start").disabled = false;
    setStatus(error.message, "error");
  }
});

$("stop")?.addEventListener("click", () => {
  window.downloader.stop();
  setStatus("Đã gửi yêu cầu dừng tiến trình tải.", "subdued");
});

/* Updater */
$("update")?.addEventListener("click", async () => {
  const result = await window.downloader.checkUpdate();
  if (result?.text) setStatus(result.text, result.state === "unconfigured" ? "error" : "subdued");
  if (result?.state === "unconfigured") window.downloader.showUpdateHelp();
});

/* Downloader IPC Stream Events */
window.downloader.onDownload((event) => {
  if (event.type === "status") {
    if ($("progress-heading")) $("progress-heading").textContent = event.message || "Đang xử lý...";
  }
  if (event.type === "jobs") {
    jobs = event.jobs || [];
    if ($("summary")) $("summary").textContent = `${event.done || 0} / ${jobs.length}`;
    if ($("progress-heading")) $("progress-heading").textContent = event.heading || "Đang tải xuống dữ liệu...";
    renderJobs();
  }
  if (event.type === "complete") {
    if ($("progress-heading")) {
      $("progress-heading").textContent = event.failed ? "Tải hoàn tất (có bài lỗi)" : "Đã tải xong toàn bộ danh sách";
    }
    setStatus(event.message, event.failed ? "error" : "ready");
  }
  if (event.type === "error") {
    setStatus(event.message, "error");
  }
  if (event.type === "runner-closed") {
    running = false;
    if ($("start")) $("start").disabled = false;
    if ($("stop")) $("stop").disabled = true;
  }
});

window.downloader.onUpdate((event) => {
  setStatus(event.text, event.state === "error" ? "error" : event.state === "ready" ? "ready" : "subdued");
});

initialize().catch((error) => setStatus(error.message, "error"));
