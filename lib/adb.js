// Thin wrapper around the `adb` CLI (Android platform-tools). Pure parsers are
// exported separately so they can be tested without a device; every command runs
// adb with an argument array (never a shell string) and a timeout.
const { spawn } = require("child_process");
const fs = require("fs");

const DEFAULT_TIMEOUT = 15000;
const INSTALL_TIMEOUT = 120000;

const ADB_NOT_FOUND = "Không tìm thấy adb. Hãy cài Android platform-tools hoặc trỏ đường dẫn tới adb.exe.";

function launchError(error, notFound) {
  if (error && error.code === "ENOENT") return new Error(notFound);
  return error instanceof Error ? error : new Error(String(error));
}

// Generic runner: used for adb and for aapt2, always with an argument array
// (never a shell string) and a timeout.
function run(bin, args, { timeout = DEFAULT_TIMEOUT, input, notFound = ADB_NOT_FOUND, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const adbError = (error) => launchError(error, notFound);
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      reject(adbError(error));
      return;
    }
    // stdout stays raw: `adb exec-out` streams file bytes, which utf8 would corrupt.
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("adb không phản hồi (quá thời gian chờ)."));
    }, timeout);
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(adbError(error)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      if (code === 0) resolve(binary ? stdout : stdout.toString("utf8"));
      else reject(new Error((stderr || stdout.toString("utf8") || `adb lỗi (mã ${code}).`).trim()));
    });
    if (input != null) child.stdin.end(input);
  });
}

const runAdb = (adb, args, options) => run(adb || "adb", args, options);

const withSerial = (serial, args) => (serial ? ["-s", serial, ...args] : args);

// adb joins shell/exec-out arguments with spaces and hands them to the phone's sh,
// so anything not validated (APK paths, entry names read out of an APK) must be quoted.
const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// PowerShell also ends a '...' string at the curly quotes ‘ ’ ‚ ‛, so a file name
// taken from an APK could break out of the string unless those are doubled too.
const psQuote = (value) => `'${String(value).replace(/['‘’‚‛]/g, "$&$&")}'`;

function assertSerial(serial) {
  if (typeof serial !== "string" || !/^[A-Za-z0-9._:-]+$/.test(serial)) {
    throw new Error("Chưa chọn thiết bị hợp lệ.");
  }
}

function assertPackage(pkg) {
  if (typeof pkg !== "string" || !/^[A-Za-z0-9._]+$/.test(pkg) || pkg.length > 255) {
    throw new Error("Tên package không hợp lệ.");
  }
}

// --- pure parsers (tested in tests/adb.test.js) ---

// `adb devices -l` -> [{ serial, state, model }]
function parseDevices(text) {
  const devices = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip the header and the "* daemon not running; starting now" lines older adb prints first.
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("List of devices")) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const model = trimmed.match(/\bmodel:(\S+)/);
    devices.push({ serial, state, model: model ? model[1].replace(/_/g, " ") : "" });
  }
  return devices;
}

// `pm list packages` / overlay output -> ["com.foo", ...]
function parsePackages(text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.trim().replace(/^package:/, "").trim())
    .filter((name) => /^[A-Za-z0-9._]+$/.test(name) && name.includes("."));
}

// Low-confidence heuristic. By design it over-flags: it only marks packages whose
// name hints at a "cleaner / booster / ad" app so a human can review them. It never
// decides anything and nothing here uninstalls on its own. A package that also holds
// the draw-over-other-apps permission is ranked High, keyword-only is Medium.
const JUNK_WORDS = [
  { word: "clean", reason: "tên gợi ý app 'dọn rác'" },
  { word: "boost", reason: "tên gợi ý app 'tăng tốc'" },
  { word: "speed", reason: "tên gợi ý app 'tăng tốc'" },
  { word: "battery", reason: "tên gợi ý app 'tiết kiệm pin'" },
  { word: "free", reason: "tên chứa 'free'" },
  { word: "theme", reason: "tên gợi ý app 'theme'" },
  { word: "lock", reason: "tên gợi ý app 'khoá màn hình'" },
  { word: "ad", reason: "tên chứa 'ad'" },
  { word: "ads", reason: "tên chứa 'ads'" },
];

function classifyJunk(packages, overlayPackages = []) {
  const overlay = new Set(overlayPackages);
  const flagged = [];
  for (const pkg of packages) {
    const tokens = String(pkg).toLowerCase().split(/[._]/).filter(Boolean);
    // Short words (ad, ads) must match a whole token so "adobe"/"download" are not flagged;
    // longer words may match a token prefix so "cleanmaster" matches "clean".
    const hits = JUNK_WORDS.filter(({ word }) =>
      tokens.some((token) => token === word || (word.length >= 4 && token.startsWith(word))));
    if (!hits.length) continue;
    const reasons = hits.map((hit) => hit.reason);
    const hasOverlay = overlay.has(pkg);
    if (hasOverlay) reasons.push("có quyền vẽ đè lên màn hình");
    flagged.push({ package: pkg, level: hasOverlay ? "High" : "Medium", reasons });
  }
  return flagged;
}

// --- device commands ---

async function listDevices(adb) {
  return parseDevices(await runAdb(adb, ["devices", "-l"]));
}

async function deviceInfo(adb, serial) {
  assertSerial(serial);
  const prop = async (name) => (await runAdb(adb, withSerial(serial, ["shell", "getprop", name]))).trim();
  const [model, androidVersion] = await Promise.all([prop("ro.product.model"), prop("ro.build.version.release")]);
  return { model, androidVersion };
}

async function listThirdPartyApps(adb, serial) {
  assertSerial(serial);
  return parsePackages(await runAdb(adb, withSerial(serial, ["shell", "pm", "list", "packages", "-3"]))).sort();
}

// Older Android builds lack `appops query-op`; treat any failure as "unknown",
// not an error, so the rest of the scan still runs.
async function overlayApps(adb, serial) {
  assertSerial(serial);
  try {
    const out = await runAdb(adb, withSerial(serial, ["shell", "cmd", "appops", "query-op", "SYSTEM_ALERT_WINDOW", "allow"]));
    return { supported: true, packages: parsePackages(out) };
  } catch {
    return { supported: false, packages: [] };
  }
}

async function scanApps(adb, serial) {
  const [apps, overlay] = await Promise.all([listThirdPartyApps(adb, serial), overlayApps(adb, serial)]);
  return { apps, overlaySupported: overlay.supported, flagged: classifyJunk(apps, overlay.packages) };
}

async function installApk(adb, serial, apkPath) {
  assertSerial(serial);
  if (typeof apkPath !== "string" || !/\.apk$/i.test(apkPath) || !fs.existsSync(apkPath)) {
    throw new Error("File APK không hợp lệ.");
  }
  const out = await runAdb(adb, withSerial(serial, ["install", "-r", apkPath]), { timeout: INSTALL_TIMEOUT });
  if (!/\bSuccess\b/.test(out)) throw new Error(out.trim() || "Cài đặt thất bại.");
  return true;
}

async function uninstallApp(adb, serial, pkg) {
  assertSerial(serial);
  assertPackage(pkg);
  const out = await runAdb(adb, withSerial(serial, ["shell", "pm", "uninstall", "-k", "--user", "0", pkg]));
  if (!/\bSuccess\b/.test(out)) throw new Error(out.trim() || "Gỡ cài đặt thất bại.");
  return true;
}

module.exports = {
  run, runAdb, withSerial, shQuote, psQuote, assertSerial, assertPackage,
  parseDevices, parsePackages, classifyJunk,
  listDevices, deviceInfo, listThirdPartyApps, overlayApps, scanApps, installApk, uninstallApp,
};
