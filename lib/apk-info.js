// Reads an app's real display name and icon by pulling just that one APK from the
// phone and asking aapt2 for its badging. adb alone cannot give either: both live
// inside the APK's compiled resources.
const fs = require("fs");
const path = require("path");
const { run, runAdb, withSerial, shQuote, psQuote, assertSerial, assertPackage } = require("./adb");
const { buildStoredZip } = require("./mini-zip");

const PULL_TIMEOUT = 180000;
const IMAGE_TYPES = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// --- pure parsers (tested in tests/apk-info.test.js) ---

// `pm path <pkg>` prints one "package:/path/to.apk" per split; we want the base APK.
function parseApkPath(text) {
  const paths = String(text).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length).trim())
    .filter(Boolean);
  return paths.find((p) => p.endsWith("base.apk")) || paths[0] || "";
}

// `aapt2 dump badging <apk>` -> { label, iconPath }. Tolerant of format differences:
// the label may come as application-label:'X' or application: label='X', and the icon
// is taken from the highest-density entry that is a real image (not an adaptive XML).
function parseBadging(text) {
  const lines = String(text).split(/\r?\n/);
  let label = "";
  const icons = [];
  let fallbackIcon = "";
  for (const line of lines) {
    const plainLabel = line.match(/^application-label:'(.*)'$/);
    if (plainLabel && !label) label = plainLabel[1];
    const appLine = line.match(/^application:\s+label='([^']*)'(?:\s+icon='([^']*)')?/);
    if (appLine) {
      if (!label) label = appLine[1];
      if (appLine[2] && !fallbackIcon) fallbackIcon = appLine[2];
    }
    const densityIcon = line.match(/^application-icon-(\d+):'(.*)'$/);
    if (densityIcon) icons.push({ density: Number(densityIcon[1]), file: densityIcon[2] });
  }
  const isImage = (file) => Object.keys(IMAGE_TYPES).includes(path.extname(String(file)).toLowerCase());
  const best = icons.filter((i) => isImage(i.file)).sort((a, b) => b.density - a.density)[0];
  const iconPath = best ? best.file : (isImage(fallbackIcon) ? fallbackIcon : "");
  return { label, iconPath };
}

// `unzip -l` listing -> [{ size, name }]. Lines look like:
//   "     1234  2024-01-01 00:00   res/mipmap-xxxhdpi/ic_launcher.png"
function parseZipList(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(\S.*?)\s*$/);
    if (match) entries.push({ size: Number(match[1]), name: match[2] });
  }
  return entries;
}

const DENSITY_RANK = ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

// aapt2 sometimes only offers an adaptive-icon XML, which is not an image. Most apps
// still ship a raster launcher icon beside it, so pick the best one by name.
function pickRasterIcon(entries) {
  const candidates = entries
    .filter((entry) => Object.keys(IMAGE_TYPES).includes(path.extname(entry.name).toLowerCase()))
    .filter((entry) => /launcher|mipmap|appicon|ic_app/i.test(entry.name))
    .map((entry) => {
      const density = DENSITY_RANK.findIndex((d) => new RegExp(`[-/]${d}[-/.]`, "i").test(entry.name));
      // A real launcher icon beats any other mipmap art; then density, then size.
      return { ...entry, score: (/launcher/i.test(entry.name) ? 1 : 0), density };
    })
    .sort((a, b) => b.score - a.score || b.density - a.density || b.size - a.size);
  return candidates.length ? candidates[0].name : "";
}

function iconDataUrl(buffer, iconPath) {
  const type = IMAGE_TYPES[path.extname(String(iconPath)).toLowerCase()];
  return type ? `data:${type};base64,${buffer.toString("base64")}` : "";
}

// --- device work ---

// Pulls one entry out of the APK (a zip) without unpacking the whole file.
function extractEntry(apk, entry, destination) {
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
    + `$z=[IO.Compression.ZipFile]::OpenRead(${psQuote(apk)}); `
    + `$e=$z.GetEntry(${psQuote(entry)}); `
    + `if($e){[IO.Compression.ZipFileExtensions]::ExtractToFile($e,${psQuote(destination)},$true)}; `
    + `$z.Dispose()`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { notFound: "Không chạy được PowerShell." });
}

const badging = (aapt2, apk) => run(aapt2, ["dump", "badging", apk], { notFound: "Không tìm thấy aapt2." });

// Fast path: copy only the entries aapt2 needs (manifest + resource table, a few
// hundred KB) straight out of the APK on the phone, and repack them into a tiny
// APK. Avoids pulling the whole 20-200MB file just to read a name and an icon.
// Needs `unzip` in the phone's shell; the caller falls back when it is missing.
async function readViaDeviceUnzip({ adb, aapt2, serial, remote, pkg, workDir }) {
  const slice = (entry) =>
    runAdb(adb, withSerial(serial, ["exec-out", "unzip", "-p", shQuote(remote), shQuote(entry)]), { binary: true, timeout: PULL_TIMEOUT });
  const manifest = await slice("AndroidManifest.xml");
  // A compiled manifest starts with 03 00 08 00; anything else is the error text of a
  // phone without unzip (old Android prints it on stdout and still exits 0).
  if (manifest.length < 4 || manifest.readUInt32LE(0) !== 0x00080003) throw new Error("Không đọc được AndroidManifest.xml.");
  deviceUnzip.set(serial, true); // unzip works here: a later failure belongs to this app only
  let table = Buffer.alloc(0);
  try { table = await slice("resources.arsc"); } catch { /* a few apps have no resource table */ }

  const mini = path.join(workDir, `${pkg}.mini.apk`);
  const entries = [{ name: "AndroidManifest.xml", data: manifest }];
  if (table.length) entries.push({ name: "resources.arsc", data: table });
  fs.writeFileSync(mini, buildStoredZip(entries));
  try {
    const { label, iconPath } = parseBadging(await badging(aapt2, mini));
    let chosen = iconPath;
    if (!chosen) {
      // aapt2 only offered an adaptive XML: look for a raster icon shipped beside it.
      const listing = await runAdb(adb, withSerial(serial, ["exec-out", "unzip", "-l", shQuote(remote)]));
      chosen = pickRasterIcon(parseZipList(listing));
    }
    // Errors here are not swallowed: unzip is known to work, so a failure means the
    // phone dropped out, and an icon-less result would be cached on disk for good.
    let icon = "";
    if (chosen) {
      const bytes = await slice(chosen);
      if (bytes.length) icon = iconDataUrl(bytes, chosen);
    }
    return { package: pkg, label: label || pkg, icon };
  } finally {
    fs.rmSync(mini, { force: true });
  }
}

// Entry listing of an APK already on this machine, shaped like parseZipList output.
async function listLocalEntries(apk) {
  const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + `$z=[IO.Compression.ZipFile]::OpenRead(${psQuote(apk)}); `
    + "$z.Entries | ForEach-Object { $_.Length.ToString() + ' x x ' + $_.FullName }; $z.Dispose()";
  return parseZipList(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { notFound: "Không chạy được PowerShell." }));
}

// Fallback: pull the whole APK and read it locally.
async function readViaPull({ adb, aapt2, serial, remote, pkg, workDir }) {
  const localApk = path.join(workDir, `${pkg}.apk`);
  const iconFile = path.join(workDir, `${pkg}.icon`);
  try {
    await runAdb(adb, withSerial(serial, ["pull", remote, localApk]), { timeout: PULL_TIMEOUT });
    const { label, iconPath } = parseBadging(await badging(aapt2, localApk));
    let chosen = iconPath || pickRasterIcon(await listLocalEntries(localApk).catch(() => []));
    let icon = "";
    if (chosen) {
      fs.rmSync(iconFile, { force: true });
      await extractEntry(localApk, chosen, iconFile);
      if (fs.existsSync(iconFile)) icon = iconDataUrl(fs.readFileSync(iconFile), chosen);
    }
    return { package: pkg, label: label || pkg, icon };
  } finally {
    // The APK is only needed while reading it; icons stay in memory, not on disk.
    fs.rmSync(localApk, { force: true });
    fs.rmSync(iconFile, { force: true });
  }
}

// Remembered per device so one phone without `unzip` does not retry it for every app.
const deviceUnzip = new Map();

async function readApkInfo({ adb, aapt2, serial, pkg, workDir }) {
  assertSerial(serial);
  assertPackage(pkg);
  const remote = parseApkPath(await runAdb(adb, withSerial(serial, ["shell", "pm", "path", pkg])));
  if (!remote) throw new Error("Không tìm thấy file APK của ứng dụng này.");
  fs.mkdirSync(workDir, { recursive: true });
  const args = { adb, aapt2, serial, remote, pkg, workDir };
  if (deviceUnzip.get(serial) !== false) {
    try {
      return await readViaDeviceUnzip(args);
    } catch (error) {
      if (deviceUnzip.get(serial) === true) throw error; // unzip works here, so this app really failed
      deviceUnzip.set(serial, false);
    }
  }
  return readViaPull(args);
}

module.exports = { parseApkPath, parseBadging, parseZipList, pickRasterIcon, iconDataUrl, readApkInfo };
