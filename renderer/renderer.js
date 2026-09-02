let state;
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

function countLinks(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;
}

function updateLinkCount() {
  const count = countLinks($("links").value);
  $("link-count").textContent = `${count} link`;
}

function setStatus(text, type = "subdued") {
  const el = $("update-status");
  el.textContent = type === "error" ? readableError(text) : text;
  el.className = `status ${type}`;
}

function renderOutputDirectory(directory) {
  $("output-directory").textContent = directory;
  $("output-directory").title = directory;
}

function switchMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  $("links").value = mode === "video" ? state.videoLinks : state.audioLinks;
  updateLinkCount();
}

function renderJobs() {
  $("empty-progress").hidden = jobs.length > 0;
  $("jobs").replaceChildren(...jobs.map((job) => {
    const item = document.createElement("article");
    item.className = `job ${job.status || ""}`;
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
    item.innerHTML = `<div class="job-row"><span class="job-title"></span><span class="job-meta"></span></div><div class="bar"><i></i></div>`;
    item.querySelector(".job-title").textContent = job.title || job.url || "Đang chuẩn bị...";
    item.querySelector(".job-meta").textContent = job.status === "failed" ? (job.error || "Lỗi") : `${percent.toFixed(1)}%${job.speed ? ` · ${job.speed}` : ""}`;
    item.querySelector("i").style.width = `${percent}%`;
    return item;
  }));
}

function renderSearchResults() {
  const container = $("search-results");
  container.hidden = searchResults.length === 0;
  $("add-search-row").hidden = searchResults.length === 0;
  $("search-count").textContent = `${searchResults.length} kết quả, đã chọn tất cả`;
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
  await window.downloader.saveLinks({ mode, contents: $("links").value });
  state[mode === "video" ? "videoLinks" : "audioLinks"] = $("links").value;
  setStatus("Đã lưu danh sách link.", "ready");
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

async function initialize() {
  initTheme();
  state = await window.downloader.state();
  renderOutputDirectory(state.outputDirectory);
  switchMode("video");
  setStatus(state.update.available ? `Phiên bản ${state.version}. Đã sẵn sàng kiểm tra cập nhật.` : `${state.version}. ${state.update.message}`);
}

/* --------------------------------------------------------------------------
   Event Listeners
   -------------------------------------------------------------------------- */
$("theme-toggle")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
});

$("links").addEventListener("input", updateLinkCount);

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", async () => {
  try {
    await saveLinks();
    switchMode(tab.dataset.mode);
  } catch (error) {
    setStatus(error.message, "error");
  }
}));

$("save-links").addEventListener("click", () => saveLinks().catch((error) => setStatus(error.message, "error")));

$("search").addEventListener("click", async () => {
  const button = $("search");
  try {
    button.disabled = true;
    button.textContent = "Đang tìm...";
    searchResults = await window.downloader.searchYoutube({
      query: $("search-query").value,
      limit: Number($("search-limit").value)
    });
    renderSearchResults();
    setStatus(searchResults.length ? `Đã tìm thấy ${searchResults.length} kết quả.` : "Không tìm thấy video phù hợp.", searchResults.length ? "ready" : "subdued");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Tìm kiếm";
  }
});

$("search-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("search").click();
});

$("add-search").addEventListener("click", async () => {
  try {
    const selected = [...document.querySelectorAll("#search-results input:checked")].map((input) => searchResults[Number(input.dataset.index)]?.url).filter(Boolean);
    if (!selected.length) {
      setStatus("Hãy chọn ít nhất một kết quả.", "error");
      return;
    }
    const existing = new Set($("links").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    const newUrls = selected.filter((url) => !existing.has(url));
    $("links").value = [$("links").value.trim(), ...newUrls].filter(Boolean).join("\n");
    updateLinkCount();
    await saveLinks();
    setStatus(newUrls.length ? `Đã thêm ${newUrls.length} link vào danh sách ${mode === "video" ? "Video" : "MP3"}.` : "Các link đã có sẵn trong danh sách.", "ready");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("open-output").addEventListener("click", () => window.downloader.openOutput().catch((error) => setStatus(error.message, "error")));

$("choose-output-directory").addEventListener("click", async () => {
  try {
    const directory = await window.downloader.chooseOutputDirectory();
    state.outputDirectory = directory;
    renderOutputDirectory(directory);
    setStatus("Đã chọn thư mục lưu file tải về.", "ready");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("start").addEventListener("click", async () => {
  try {
    const folder = state.outputDirectory;
    if (!folder) throw new Error("Hãy chọn thư mục lưu trước.");
    await saveLinks();
    jobs = [];
    renderJobs();
    running = true;
    $("start").disabled = true;
    $("stop").disabled = false;
    $("progress-heading").textContent = "Đang chuẩn bị tải...";
    await window.downloader.start({ mode, outputDirectory: folder });
  } catch (error) {
    running = false;
    $("stop").disabled = true;
    $("start").disabled = false;
    setStatus(error.message, "error");
  }
});

$("stop").addEventListener("click", () => window.downloader.stop());

$("update").addEventListener("click", async () => {
  const result = await window.downloader.checkUpdate();
  if (result?.text) setStatus(result.text, result.state === "unconfigured" ? "error" : "subdued");
  if (result?.state === "unconfigured") window.downloader.showUpdateHelp();
});

window.downloader.onDownload((event) => {
  if (event.type === "status") {
    $("progress-heading").textContent = event.message || "Đang chuẩn bị...";
  }
  if (event.type === "jobs") {
    jobs = event.jobs;
    $("summary").textContent = `${event.done || 0} / ${jobs.length}`;
    $("progress-heading").textContent = event.heading || "Đang tải...";
    renderJobs();
  }
  if (event.type === "complete") {
    $("progress-heading").textContent = event.failed ? "Hoàn tất, có lỗi" : "Đã tải xong";
    setStatus(event.message, event.failed ? "error" : "ready");
  }
  if (event.type === "error") {
    setStatus(event.message, "error");
  }
  if (event.type === "runner-closed") {
    running = false;
    $("start").disabled = false;
    $("stop").disabled = true;
  }
});

window.downloader.onUpdate((event) => {
  setStatus(event.text, event.state === "error" ? "error" : event.state === "ready" ? "ready" : "subdued");
});

initialize().catch((error) => setStatus(error.message, "error"));
