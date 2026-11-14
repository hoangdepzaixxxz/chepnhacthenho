// Android device screen. Reuses $, showToast and readableError from renderer.js
// (classic scripts share the top-level scope; this file loads after renderer.js).
(() => {
  let selectedSerial = "";
  let loaded = false;
  let pollTimer = null;
  let polling = false;
  let lastSignature = "";
  let rowParts = new Map();
  let infoRun = 0;
  const POLL_MS = 2500;

  const downloadsView = $("downloads-view");
  const androidView = $("android-view");
  const defaultSub = $("adb-sub").textContent;

  function showView(android) {
    androidView.hidden = !android;
    downloadsView.hidden = android;
    $("nav-android").setAttribute("aria-selected", String(android));
    $("nav-downloads").setAttribute("aria-selected", String(!android));
    if (android) {
      if (!loaded) { loaded = true; loadAdbPath(); }
      refreshDevices(true);
    } else {
      // Name reading carries on in the background: stopping it here left every
      // unread row stuck on "Đang chờ đọc tên…" when the screen was reopened.
      stopPoll();
    }
  }

  // Poll only while connected: a successful scan keeps it running (to catch plug/unplug),
  // a hard error (e.g. adb missing) stops it so the console isn't flooded. A manual
  // refresh or saving the adb path restarts it.
  function ensurePoll() {
    if (!androidView.hidden && !pollTimer) pollTimer = setInterval(() => refreshDevices(false), POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function loadAdbPath() {
    try { $("adb-path").value = await window.android.getAdbPath(); } catch { /* keep empty */ }
  }

  async function saveAdbPath() {
    try {
      const saved = await window.android.setAdbPath($("adb-path").value);
      $("adb-path").value = saved;
      showToast(saved ? "Đã lưu đường dẫn adb." : "Sẽ dùng adb trong PATH.", "success");
      refreshDevices(true);
    } catch (error) { showToast(readableError(error), "error"); }
  }

  async function browseAdb() {
    try {
      const picked = await window.android.browseAdb();
      if (picked) $("adb-path").value = picked;
    } catch (error) { showToast(readableError(error), "error"); }
  }

  async function downloadAdb() {
    const button = $("adb-download");
    button.disabled = true;
    $("adb-path-status").textContent = "Đang tải adb…";
    try {
      await window.android.installAdb();
      $("adb-path-status").textContent = "Đã tải adb. Đang tìm thiết bị…";
      showToast("Đã tải adb xong.", "success");
      refreshDevices(true);
    } catch (error) {
      $("adb-path-status").textContent = readableError(error);
      showToast(readableError(error), "error");
    } finally {
      button.disabled = false;
    }
  }

  window.android.onInstallProgress((data) => {
    const tool = data.label || "adb";
    if (data.state === "downloading") $("adb-path-status").textContent = `Đang tải ${tool}… ${data.percent || 0}%`;
    else if (data.state === "extracting") $("adb-path-status").textContent = `Đang giải nén ${tool}…`;
    else if (data.state === "done") $("adb-path-status").textContent = `Đã tải ${tool}.`;
    else if (data.state === "error") $("adb-path-status").textContent = `Tải ${tool} thất bại: ${data.message || ""}`;
  });

  function setAppsEnabled(on) {
    $("adb-install").disabled = !on;
    $("adb-scan").disabled = !on;
  }

  // force=true always re-renders (manual refresh / view open); the background poll
  // passes false and only touches the DOM when the device set actually changed.
  async function refreshDevices(force) {
    if (polling) return;
    polling = true;
    try {
      const result = await window.android.devices();
      if (result.error) {
        // adb missing / not reachable: stop polling, show the reason, toast on manual refresh.
        // The signature is dropped so the next good scan redraws over this message.
        stopPoll();
        lastSignature = "";
        resetApps(); // no device list means nothing is selected: don't leave Install/Scan live
        $("adb-devices").textContent = "";
        $("adb-device-count").textContent = result.error;
        $("adb-device-empty").hidden = false;
        if (force) showToast(result.error, "error");
        return;
      }
      const devices = result.devices;
      const signature = devices.map((d) => `${d.serial}:${d.state}`).join("|");
      if (!force && signature === lastSignature) { ensurePoll(); return; }
      lastSignature = signature;
      const list = $("adb-devices");
      list.textContent = "";
      $("adb-device-empty").hidden = devices.length > 0;
      $("adb-device-count").textContent = devices.length ? `${devices.length} thiết bị` : "Không thấy thiết bị";
      // A selected phone that went offline / unauthorized can no longer be used either.
      if (!devices.some((d) => d.serial === selectedSerial && d.state === "device")) resetApps();
      for (const device of devices) list.appendChild(deviceRow(device));
      // One phone ready and nothing picked yet: select it and show its apps at once.
      const ready = devices.filter((d) => d.state === "device");
      if (!selectedSerial && ready.length === 1) selectDevice(ready[0].serial);
      ensurePoll();
    } catch (error) {
      stopPoll();
      lastSignature = "";
      if (force) showToast(readableError(error), "error");
    } finally {
      polling = false;
    }
  }

  function deviceRow({ serial, state, model }) {
    const li = document.createElement("li");
    li.className = "adb-item";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "adb-device";
    btn.setAttribute("aria-pressed", String(serial === selectedSerial));
    const ready = state === "device";
    btn.disabled = !ready;

    const title = document.createElement("span");
    title.className = "adb-device-name";
    title.textContent = ready ? (model || serial) : serial;
    const sub = document.createElement("span");
    sub.className = "meta";
    sub.textContent = ready ? serial : stateLabel(state);
    btn.append(title, sub);
    if (ready) btn.addEventListener("click", () => selectDevice(serial));
    li.appendChild(btn);
    return li;
  }

  const stateLabel = (state) =>
    state === "unauthorized" ? "Chưa cấp quyền — đồng ý trên điện thoại"
    : state === "offline" ? "Mất kết nối"
    : state;

  function resetApps() {
    selectedSerial = "";
    infoRun += 1; // cancel any name/icon reading still in flight
    rowParts = new Map();
    setAppsEnabled(false);
    $("adb-apps").textContent = "";
    $("adb-app-count").textContent = "Chọn một thiết bị";
    $("adb-sub").textContent = defaultSub;
    $("adb-scan-panel").hidden = true;
  }

  const appCountText = () => `${rowParts.size} ứng dụng (bên thứ ba)`;

  async function selectDevice(serial) {
    selectedSerial = serial;
    setAppsEnabled(true);
    $("adb-scan-panel").hidden = true;
    for (const b of document.querySelectorAll(".adb-device"))
      b.setAttribute("aria-pressed", String(b.querySelector(".meta").textContent === serial));
    try {
      const info = await window.android.deviceInfo(serial);
      if (serial !== selectedSerial) return; // unplugged, or another phone picked meanwhile
      $("adb-sub").textContent = `${info.model || serial} · Android ${info.androidVersion || "?"}`;
    } catch (error) {
      if (serial !== selectedSerial) return;
      showToast(readableError(error), "error");
    }
    loadApps();
  }

  async function loadApps() {
    const serial = selectedSerial;
    const list = $("adb-apps");
    infoRun += 1; // the rows about to be replaced must not be written to any more
    list.textContent = "Đang đọc danh sách ứng dụng…";
    try {
      const apps = await window.android.apps(serial);
      if (serial !== selectedSerial) return;
      list.textContent = "";
      rowParts = new Map();
      for (const pkg of apps) list.appendChild(appRow(pkg));
      $("adb-app-count").textContent = appCountText();
      loadAllInfo(apps);
    } catch (error) {
      if (serial !== selectedSerial) return;
      list.textContent = "";
      rowParts = new Map();
      $("adb-app-count").textContent = "Không đọc được danh sách ứng dụng";
      showToast(readableError(error), "error");
    }
  }

  function appRow(pkg) {
    const li = document.createElement("li");
    li.className = "adb-item adb-app";
    li.dataset.pkg = pkg;

    const icon = document.createElement("img");
    icon.className = "adb-icon";
    icon.alt = "";
    icon.hidden = true;
    const blank = document.createElement("span");
    blank.className = "adb-icon adb-icon-blank";
    blank.setAttribute("aria-hidden", "true");

    // The real name and icon live inside the APK, so they load only when asked.
    const open = document.createElement("button");
    open.type = "button";
    open.className = "adb-appname";
    const title = document.createElement("span");
    title.className = "adb-pkg";
    title.textContent = pkg;
    const sub = document.createElement("span");
    sub.className = "meta";
    sub.textContent = "Đang chờ đọc tên…";
    open.append(title, sub);
    const parts = { icon, blank, title, sub, open };
    rowParts.set(pkg, parts);
    // Everything loads on its own; clicking just retries an app that failed.
    open.addEventListener("click", () => loadAppInfo(pkg, parts));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost small";
    btn.textContent = "Gỡ";
    btn.addEventListener("click", () => uninstall(pkg));

    li.append(blank, icon, open, btn);
    return li;
  }

  function applyInfo(parts, pkg, info) {
    if (!parts) return;
    const label = info.label || pkg;
    parts.title.textContent = label;
    parts.sub.textContent = pkg;
    if (info.icon) {
      parts.icon.src = info.icon;
      parts.icon.hidden = false;
      parts.blank.hidden = true;
      return;
    }
    // Apps whose logo is a vector have no image to show: stand in with the first
    // letter on a colour fixed by the package name, so no row is left blank.
    let hash = 0;
    for (let i = 0; i < pkg.length; i += 1) hash = (hash * 31 + pkg.charCodeAt(i)) >>> 0;
    parts.blank.textContent = label.trim().charAt(0).toUpperCase() || "?";
    parts.blank.style.backgroundColor = `hsl(${hash % 360} 48% 40%)`;
    parts.blank.classList.add("adb-icon-letter");
  }

  async function loadAppInfo(pkg, parts) {
    if (parts.open.disabled) return;
    parts.open.disabled = true;
    parts.sub.textContent = "Đang đọc tên và icon…";
    try {
      applyInfo(parts, pkg, await window.android.appInfo(selectedSerial, pkg));
    } catch (error) {
      parts.sub.textContent = readableError(error);
    } finally {
      parts.open.disabled = false;
    }
  }

  // Reads every app's real name and icon, a few at a time: adb serves several
  // commands at once, and one by one a phone with 100 apps took minutes.
  // infoRun is bumped whenever the list changes, which cancels a run in flight.
  async function loadAllInfo(packages) {
    const run = ++infoRun;
    const serial = selectedSerial;
    const queue = [...packages];
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        if (run !== infoRun) return;
        const pkg = queue.shift();
        const parts = rowParts.get(pkg);
        if (!parts) continue; // uninstalled while the list was being read
        parts.sub.textContent = "Đang đọc tên và icon…";
        try {
          const info = await window.android.appInfo(serial, pkg);
          if (run !== infoRun) return;
          applyInfo(parts, pkg, info);
        } catch (error) {
          // Checked here too: a cancelled run must not write its count over the reset list.
          if (run !== infoRun) return;
          parts.sub.textContent = readableError(error);
        }
        done += 1;
        $("adb-app-count").textContent = `${rowParts.size} ứng dụng · đang đọc tên ${done}/${rowParts.size}`;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (run === infoRun) $("adb-app-count").textContent = appCountText();
  }

  async function uninstall(pkg) {
    if (!window.confirm(`Gỡ ứng dụng ${pkg}? Dữ liệu được giữ lại (-k).`)) return;
    const serial = selectedSerial;
    try {
      await window.android.uninstall(serial, pkg);
      showToast(`Đã gỡ ${pkg}.`, "success");
      if (serial !== selectedSerial) return;
      // The same app can sit in both the app list and the scan results.
      for (const li of androidView.querySelectorAll("li[data-pkg]")) if (li.dataset.pkg === pkg) li.remove();
      rowParts.delete(pkg);
      $("adb-app-count").textContent = appCountText();
    } catch (error) { showToast(readableError(error), "error"); }
  }

  async function install() {
    const button = $("adb-install");
    button.disabled = true; // an install can take a minute; a second click would start another
    try {
      const result = await window.android.install(selectedSerial);
      if (result.canceled) return;
      showToast(`Đã cài ${result.apk}.`, "success");
      if (selectedSerial) loadApps();
    } catch (error) {
      showToast(readableError(error), "error");
    } finally {
      button.disabled = !selectedSerial;
    }
  }

  async function scan() {
    const serial = selectedSerial;
    const list = $("adb-scan-results");
    $("adb-scan-panel").hidden = false;
    list.textContent = "Đang quét…";
    try {
      const { flagged, overlaySupported } = await window.android.scan(serial);
      if (serial !== selectedSerial) return;
      list.textContent = "";
      $("adb-scan-note").textContent = flagged.length
        ? `${flagged.length} app nghi ngờ theo tên package — tự xem lại, không có gì tự gỡ.${overlaySupported ? "" : " (Máy này không đọc được quyền vẽ đè.)"}`
        : "Không thấy app nào khớp mẫu nghi ngờ.";
      for (const item of flagged) list.appendChild(scanRow(item));
    } catch (error) {
      list.textContent = "";
      showToast(readableError(error), "error");
    }
  }

  function scanRow({ package: pkg, level, reasons }) {
    const li = document.createElement("li");
    li.className = "adb-item adb-app";
    li.dataset.pkg = pkg;
    const info = document.createElement("div");
    info.className = "adb-scan-info";
    const name = document.createElement("span");
    name.className = "adb-pkg";
    name.textContent = pkg;
    const why = document.createElement("span");
    why.className = "meta";
    why.textContent = reasons.join(" · ");
    info.append(name, why);
    const badge = document.createElement("span");
    badge.className = `adb-badge adb-badge-${level.toLowerCase()}`;
    badge.textContent = level === "High" ? "Cao" : "Vừa";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost small";
    btn.textContent = "Gỡ";
    btn.addEventListener("click", () => uninstall(pkg));
    li.append(badge, info, btn);
    return li;
  }

  $("nav-android").addEventListener("click", () => showView(true));
  $("nav-downloads").addEventListener("click", () => showView(false));
  $("adb-refresh").addEventListener("click", () => refreshDevices(true));
  $("adb-save-path").addEventListener("click", saveAdbPath);
  $("adb-browse").addEventListener("click", browseAdb);
  $("adb-download").addEventListener("click", downloadAdb);
  $("adb-install").addEventListener("click", install);
  $("adb-scan").addEventListener("click", scan);
})();
