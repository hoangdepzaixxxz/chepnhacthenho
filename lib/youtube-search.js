// YouTube search shared by the desktop shell (desktop-main.js) and the CLI (1.js).

// yt-search enables its own debug logging when process.env.debug is set, so hide
// that variable while the module loads.
const debugValue = process.env.debug;
delete process.env.debug;
const yts = require("yt-search");
if (debugValue !== undefined) process.env.debug = debugValue;

// YouTube writes ages both long ("3 days ago", "3 ngày trước") and short
// ("3d ago", "2mo ago", "Streamed 5h ago").
const UNITS = [
  [/^(s|secs?|seconds?|giây)$/, 1_000],
  [/^(m|mins?|minutes?|phút)$/, 60_000],
  [/^(h|hrs?|hours?|giờ)$/, 3_600_000],
  [/^(d|days?|ngày)$/, 86_400_000],
  [/^(w|wks?|weeks?|tuần)$/, 604_800_000],
  [/^(mo|mos|months?|tháng)$/, 2_629_800_000],
  [/^(y|yrs?|years?|năm)$/, 31_557_600_000],
];

// Turns yt-search's upload age into milliseconds so newer uploads can be listed
// first. Unknown values sort last.
function videoAgeMs(ago) {
  const text = String(ago || "").trim().toLowerCase();
  if (!text) return Number.POSITIVE_INFINITY;
  if (/^(just now|vừa xong|mới đăng|mới phát hành)$/.test(text)) return 0;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(\p{L}+)/u);
  const unit = match && UNITS.find(([pattern]) => pattern.test(match[2]));
  if (!unit) return Number.POSITIVE_INFINITY;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(amount) ? amount * unit[1] : Number.POSITIVE_INFINITY;
}

// Returns at most `limit` unique videos, newest uploads first.
async function searchYouTube(query, limit) {
  const result = await yts(query);
  const seen = new Set();
  return (result.videos || [])
    .filter((video) => video.url && video.videoId && !seen.has(video.videoId) && seen.add(video.videoId))
    .map((video, index) => ({ video, index, age: videoAgeMs(video.ago) }))
    .sort((a, b) => a.age - b.age || a.index - b.index)
    .slice(0, limit)
    .map(({ video }) => ({
      title: String(video.title || "Video YouTube"),
      url: video.url,
      ago: String(video.ago || ""),
      duration: String(video.timestamp || ""),
      author: String(video.author?.name || ""),
      thumbnail: /^https:\/\/i\.ytimg\.com\//.test(video.thumbnail || "") ? video.thumbnail : "",
    }));
}

module.exports = { searchYouTube, videoAgeMs };
