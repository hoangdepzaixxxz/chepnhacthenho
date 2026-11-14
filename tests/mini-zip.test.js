const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { crc32, buildStoredZip } = require("../lib/mini-zip");

test("crc32 matches the known value for '123456789'", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("buildStoredZip writes a central directory the headers agree on", () => {
  const zip = buildStoredZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50); // local file header
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50); // end of central directory
  assert.equal(zip.readUInt16LE(end + 10), 1); // one entry
  const directoryStart = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(directoryStart), 0x02014b50); // central directory header
  assert.equal(zip.readUInt32LE(end + 12), end - directoryStart); // directory size
});

// The point of this writer is that a real unzip implementation accepts what it makes.
test("a real zip reader can open the archive and read the bytes back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minizip-"));
  const zipPath = path.join(dir, "t.zip");
  const payload = Buffer.from("xin chào thế giới", "utf8");
  fs.writeFileSync(zipPath, buildStoredZip([
    { name: "AndroidManifest.xml", data: payload },
    { name: "resources.arsc", data: Buffer.from([1, 2, 3, 0, 255]) },
  ]));
  try {
    // Compared as base64 so the shell's text encoding cannot distort the bytes.
    const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem;"
      + `$z=[IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');`
      + "$n=($z.Entries | ForEach-Object { $_.FullName }) -join ',';"
      + "$m=New-Object IO.MemoryStream; $z.GetEntry('AndroidManifest.xml').Open().CopyTo($m);"
      + "$n + '|' + [Convert]::ToBase64String($m.ToArray()); $z.Dispose()";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
    const [names, base64] = out.split("|");
    assert.equal(names, "AndroidManifest.xml,resources.arsc");
    assert.equal(base64, payload.toString("base64"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
