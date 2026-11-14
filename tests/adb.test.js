const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDevices, parsePackages, classifyJunk, shQuote } = require("../lib/adb");

test("parseDevices reads serial, state and model, skipping the header", () => {
  const out = [
    "List of devices attached",
    "ABC123   device product:foo model:Redmi_Note_8 device:bar",
    "ZZZ999   unauthorized",
    "",
  ].join("\n");
  assert.deepEqual(parseDevices(out), [
    { serial: "ABC123", state: "device", model: "Redmi Note 8" },
    { serial: "ZZZ999", state: "unauthorized", model: "" },
  ]);
});

test("parseDevices ignores daemon start-up lines before the header", () => {
  const out = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nABC123\tdevice\n";
  assert.deepEqual(parseDevices(out), [{ serial: "ABC123", state: "device", model: "" }]);
});

test("shQuote keeps shell metacharacters in an APK entry name inert", () => {
  assert.equal(shQuote("res/a;rm -rf x.png"), "'res/a;rm -rf x.png'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test("parsePackages strips the package: prefix and junk lines", () => {
  const out = "package:com.foo.bar\npackage:com.baz\nrandom noise\n\n";
  assert.deepEqual(parsePackages(out), ["com.foo.bar", "com.baz"]);
});

test("classifyJunk flags keyword hits, High when it can draw overlays", () => {
  const packages = ["com.phone.cleanmaster", "com.good.adobe", "com.ads.sdk", "com.normal.app"];
  const result = classifyJunk(packages, ["com.ads.sdk"]);
  const byPkg = Object.fromEntries(result.map((r) => [r.package, r.level]));
  assert.equal(byPkg["com.phone.cleanmaster"], "Medium"); // "clean" prefix match
  assert.equal(byPkg["com.ads.sdk"], "High"); // "ads" token + overlay permission
  assert.equal(byPkg["com.good.adobe"], undefined); // "adobe" must not match short word "ad"
  assert.equal(byPkg["com.normal.app"], undefined);
});

test("psQuote keeps curly quotes from ending a PowerShell string", async () => {
  const { run, psQuote } = require("../lib/adb");
  const name = "res/a\u2019;Write-Output pwned;\u2018it's.png";
  // Asked for the length so the console code page cannot garble the comparison.
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(${psQuote(name)}).Length`]);
  assert.equal(out.trim(), String(name.length));
});
