const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseApkPath, parseBadging, parseZipList, pickRasterIcon, iconDataUrl } = require("../lib/apk-info");

test("parseApkPath prefers base.apk among splits", () => {
  const out = [
    "package:/data/app/~~ab==/com.foo-1/split_config.vi.apk",
    "package:/data/app/~~ab==/com.foo-1/base.apk",
    "",
  ].join("\n");
  assert.equal(parseApkPath(out), "/data/app/~~ab==/com.foo-1/base.apk");
  assert.equal(parseApkPath("package:/data/app/only.apk"), "/data/app/only.apk");
  assert.equal(parseApkPath("rác\n"), "");
});

test("parseBadging takes the label and the highest-density real image icon", () => {
  const out = [
    "package: name='com.facebook.katana' versionCode='1' versionName='1.0'",
    "application-label:'Facebook'",
    "application-label-vi:'Facebook VN'",
    "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
    "application-icon-640:'res/mipmap-xxxhdpi-v4/ic_launcher.png'",
    "application: label='Facebook' icon='res/mipmap-mdpi-v4/ic_launcher.png'",
  ].join("\n");
  assert.deepEqual(parseBadging(out), {
    label: "Facebook",
    iconPath: "res/mipmap-xxxhdpi-v4/ic_launcher.png",
  });
});

test("parseBadging skips adaptive-icon XML and falls back to the application line", () => {
  const out = [
    "application-icon-640:'res/mipmap-anydpi-v26/ic_launcher.xml'",
    "application: label='Zalo' icon='res/mipmap-xhdpi/ic.webp'",
  ].join("\n");
  assert.deepEqual(parseBadging(out), { label: "Zalo", iconPath: "res/mipmap-xhdpi/ic.webp" });
});

test("parseBadging returns empty icon when nothing usable is present", () => {
  assert.deepEqual(parseBadging("application-label:'X'"), { label: "X", iconPath: "" });
});

test("iconDataUrl maps the extension to a media type, empty for unknown", () => {
  assert.equal(iconDataUrl(Buffer.from("hi"), "a/b.png"), "data:image/png;base64,aGk=");
  assert.equal(iconDataUrl(Buffer.from("hi"), "a/b.xml"), "");
});

test("parseZipList reads size and name from an unzip -l listing", () => {
  const out = [
    "Archive:  base.apk",
    "  Length      Date    Time    Name",
    "---------  ---------- -----   ----",
    "    29980  2024-01-01 00:00   AndroidManifest.xml",
    "    12345  2024-01-01 00:00   res/mipmap-xxxhdpi/ic_launcher.png",
    "---------                     -------",
  ].join("\n");
  const entries = parseZipList(out);
  assert.deepEqual(entries.slice(0, 2), [
    { size: 29980, name: "AndroidManifest.xml" },
    { size: 12345, name: "res/mipmap-xxxhdpi/ic_launcher.png" },
  ]);
});

test("pickRasterIcon prefers a launcher icon at the highest density", () => {
  const entries = [
    { size: 900, name: "res/mipmap-mdpi/ic_launcher.png" },
    { size: 5000, name: "res/mipmap-xxxhdpi/ic_launcher.png" },
    { size: 90000, name: "res/drawable-xxxhdpi/splash_background.png" },
    { size: 100, name: "res/mipmap-anydpi-v26/ic_launcher.xml" },
    { size: 2000, name: "res/mipmap-xxhdpi/other_art.webp" },
  ];
  assert.equal(pickRasterIcon(entries), "res/mipmap-xxxhdpi/ic_launcher.png");
});

test("pickRasterIcon returns empty when only vectors or unrelated images exist", () => {
  assert.equal(pickRasterIcon([
    { size: 10, name: "res/Qr.xml" },
    { size: 99, name: "res/kg.png" },
  ]), "");
});
