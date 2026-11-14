// Background music: a short list of recent Vietnamese chill tracks played through the
// SoundCloud widget. The top bar shows what is playing with previous / play-pause / next;
// clicking it opens the track list, where clicking a cover plays that track.
(() => {
  // Chosen 2026-11-04: uploaded May–Sep 2026, embeddable, fully playable (not 30 s previews)
  // and streamed without DRM, which Electron cannot decode. `art` is the track's artwork
  // (the uploader's avatar when the track has none), `length` its duration in seconds.
  const TRACKS = [
    { title: "Không Thành (Indie Chill)", artist: "Hyden Tran", length: 248, url: "https://soundcloud.com/hydentran666/tama-kh-ng-th-nh-indie-chill", art: "https://i1.sndcdn.com/artworks-n19ejOXtjH3yErWO-Ql8JyQ-large.png" },
    { title: "Đi Cùng Anh (Deep Chill)", artist: "Minh Nguyen", length: 252, url: "https://soundcloud.com/minh-nguyen-369100723/i-c-ng-anh-2026-version", art: "https://i1.sndcdn.com/artworks-IyLa0Hy3fwQymDZo-KKmpOA-large.jpg" },
    { title: "Phía Sau Em (VietChill)", artist: "VanhPumpkin", length: 265, url: "https://soundcloud.com/vi-t-anh-165899236/phia-sau-em-vietchill", art: "https://i1.sndcdn.com/artworks-K5CoqV96YTkKUvew-ysabNw-large.png" },
    { title: "Đành Quên (MGM Cover)", artist: "MarchGMusic", length: 273, url: "https://soundcloud.com/marchgmusic/nh-qu-n-tony-vi-t-mgm-cover", art: "https://i1.sndcdn.com/artworks-6ogzWQjDmh2z52lJ-fdEBQg-large.png" },
    { title: "Chẳng Cần Bình Yên (Indie Deep Chill)", artist: "Hyden Tran", length: 262, url: "https://soundcloud.com/hydentran666/ch-ng-c-n-b-nh-y-n-indie-deep", art: "https://i1.sndcdn.com/artworks-OVw4ujFh94qqDRyB-cQoi4w-large.png" },
    { title: "Vừa Hận Vừa Yêu (VietChill)", artist: "Thịnh Trần", length: 156, url: "https://soundcloud.com/th-nh-tr-n-974609807/v-a-h-n-v-a-y-u-vietchill", art: "https://i1.sndcdn.com/artworks-zgCktCdtrkZCWx46-MJt8dg-large.jpg" },
    { title: "Biết Nói Là Tại Sao (Lofi Ver.)", artist: "Shen", length: 257, url: "https://soundcloud.com/c-u-v-ng-909591098/bi-t-n-i-l-t-i-sao-lofi-ver-kh", art: "https://i1.sndcdn.com/avatars-zSw7U3riISGe7fa5-r6uaIw-large.jpg" },
    { title: "Một Người Luôn Yêu Em Đấy (Indie Chill)", artist: "Hyden Tran", length: 265, url: "https://soundcloud.com/hydentran666/m-t-ng-i-lu-n-y-u-em-y-indie", art: "https://i1.sndcdn.com/artworks-nBI1W5jDrT0rJDcI-u8B45w-large.png" },
    { title: "Có Công Mài Sắc (Lofi Chill)", artist: "Huy Nhật", length: 229, url: "https://soundcloud.com/huy-nh-t-873065339/c-c-ng-m-i-s-c-lofi-chill", art: "https://i1.sndcdn.com/artworks-iJhInSgKoyUO7KBD-OqXcLw-large.png" },
    { title: "Thì Quá Khứ (Indie Jersey Chill)", artist: "Hyden Tran", length: 245, url: "https://soundcloud.com/hydentran666/th-qu-kh-indie-jersey-chill", art: "https://i1.sndcdn.com/artworks-2cE5Xn58blMS1Gga-eLtRTA-large.jpg" },
  ];
  const WIDGET_OPTIONS = {
    auto_play: false,
    show_artwork: false,
    show_comments: false,
    show_user: false,
    sharing: false,
    buying: false,
    download: false,
  };
  const VOLUME = 40;
  const LOAD_TIMEOUT_MS = 30000;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const player = $("player");
  const button = $("music-toggle");
  const status = $("music-status");
  const titleEl = $("music-title");
  const artistEl = $("music-artist");
  const cover = $("music-cover");
  const coverBlank = $("music-cover-blank");
  const pickButton = $("music-pick");
  const list = $("music-list");
  const tracksEl = $("music-tracks");

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* not persisted */ } },
  };

  let index = Math.max(0, Math.min(TRACKS.length - 1, Number(storage.get("music-track")) || 0));
  // Plays on start unless the listener turned the music off last time.
  let wanted = storage.get("music-off") !== "1";
  let widget = null;
  let frame = null;
  let sdk = null;
  let ready = false;
  let failuresInARow = 0;
  let timeout = null;
  let loadToken = 0; // only the most recent load may start playback

  const LABELS = {
    loading: "Đang tải nhạc nền · bấm để tắt",
    playing: "Tạm dừng nhạc nền",
    paused: "Phát nhạc nền",
    error: "Không phát được nhạc · bấm để thử lại",
  };

  const formatLength = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; // m:ss clock, taste-skill-ignore

  /* ---------- the track list ---------- */
  function icon(className, pathData) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
    return svg;
  }

  function blankArt() {
    const blank = document.createElement("span");
    blank.className = "track-blank";
    return blank;
  }

  function buildList() {
    const rows = TRACKS.map((track, trackIndex) => {
      const row = document.createElement("li");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "track";
      pick.dataset.index = String(trackIndex);

      const art = document.createElement("span");
      art.className = "track-art";
      const img = document.createElement("img");
      img.alt = "";
      img.width = 44;
      img.height = 44;
      img.decoding = "async";
      img.src = track.art;
      img.addEventListener("error", () => img.replaceWith(blankArt()), { once: true });
      const overlay = document.createElement("span");
      overlay.className = "track-overlay";
      overlay.setAttribute("aria-hidden", "true");
      const bars = document.createElement("span");
      bars.className = "eq";
      bars.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      overlay.append(icon("icon-play", "M7 4v16l13-8z"), icon("icon-pause", "M8 5v14M16 5v14"), bars);
      art.append(img, overlay);

      const copy = document.createElement("span");
      copy.className = "track-copy";
      const title = document.createElement("span");
      title.className = "track-title";
      title.textContent = track.title;
      const artist = document.createElement("span");
      artist.className = "track-artist";
      artist.textContent = track.artist;
      copy.append(title, artist);

      const length = document.createElement("span");
      length.className = "track-length num";
      length.textContent = formatLength(track.length);

      pick.append(art, copy, length);
      row.append(pick);
      return row;
    });
    tracksEl.replaceChildren(...rows);
  }

  function trackButtons() {
    return [...tracksEl.querySelectorAll(".track")];
  }

  // Marks the current track and mirrors the player state (loading / playing / paused / error).
  function renderList() {
    list.dataset.state = button.dataset.state;
    trackButtons().forEach((pick, trackIndex) => {
      const current = trackIndex === index;
      pick.setAttribute("aria-current", String(current));
      pick.title = current
        ? (button.dataset.state === "playing" ? "Đang phát · bấm để tạm dừng" : "Bấm để phát bài này")
        : "Bấm để phát bài này";
    });
  }

  function openList() {
    list.hidden = false;
    pickButton.setAttribute("aria-expanded", "true");
    const current = trackButtons()[index];
    current?.scrollIntoView({ block: "nearest" });
    current?.focus({ preventScroll: true });
  }

  function closeList({ restoreFocus = false } = {}) {
    if (list.hidden) return;
    list.hidden = true;
    pickButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) pickButton.focus();
  }

  /* ---------- what is playing ---------- */
  function render(state) {
    button.dataset.state = state;
    button.title = LABELS[state];
    button.setAttribute("aria-label", LABELS[state]);
    button.setAttribute("aria-pressed", String(state === "playing"));
    status.textContent = state === "playing" ? `Đang phát ${TRACKS[index].title}` : LABELS[state];
    renderList();
  }

  function showTrack() {
    const track = TRACKS[index];
    titleEl.textContent = track.title;
    artistEl.textContent = `${track.artist} · ${index + 1}/${TRACKS.length}`;
    if (cover.getAttribute("src") !== track.art) cover.src = track.art;
    cover.hidden = false;
    coverBlank.hidden = true;
    renderList();
  }

  cover.addEventListener("error", () => {
    cover.hidden = true;
    coverBlank.hidden = false;
  });

  // Some tracks stream only as DRM-encrypted HLS: the widget then reports "playing" in silence.
  function playable(sound) {
    const streams = sound?.media?.transcodings;
    if (!Array.isArray(streams) || !streams.length) return true; // unknown: the watch below decides
    return streams.some((stream) => /^(hls|progressive)$/.test(stream?.format?.protocol || ""));
  }

  // Until the position first moves, a track counts as loading; one that never moves is skipped.
  function watchLoading() {
    clearTimeout(timeout);
    timeout = setTimeout(() => skipBroken(), LOAD_TIMEOUT_MS);
  }

  // A track that will not load is skipped; after every track has failed in a row, give up.
  function skipBroken() {
    failuresInARow += 1;
    if (failuresInARow >= TRACKS.length) {
      clearTimeout(timeout);
      wanted = false;
      render("error");
      return;
    }
    go(index + 1);
  }

  // Runs once the current track is loaded: on the widget's first READY, and through
  // load()'s callback after a track change (the widget does not fire READY again).
  function onLoaded() {
    ready = true;
    widget.setVolume(VOLUME);
    widget.getCurrentSound((sound) => {
      if (!playable(sound)) {
        skipBroken();
        return;
      }
      if (wanted) {
        watchLoading();
        widget.play();
      } else {
        clearTimeout(timeout);
        render("paused");
      }
    });
  }

  function bind() {
    const events = window.SC.Widget.Events;
    widget.bind(events.READY, () => {
      if (loadToken === 0) onLoaded();
    });
    widget.bind(events.PLAY, () => {
      // A late PLAY from the previous track while the next one loads says nothing.
      if (!ready) return;
      if (!wanted) {
        widget.pause();
        return;
      }
      render("playing");
    });
    widget.bind(events.PAUSE, () => {
      if (!wanted) render("paused");
    });
    widget.bind(events.PLAY_PROGRESS, (progress) => {
      if (!ready || !timeout || !(progress?.currentPosition > 0)) return;
      clearTimeout(timeout);
      timeout = null;
      failuresInARow = 0;
    });
    widget.bind(events.FINISH, () => go(index + 1));
    widget.bind(events.ERROR, () => skipBroken());
  }

  function createWidget() {
    frame = document.createElement("iframe");
    frame.className = "music-frame";
    frame.title = "Nhạc nền SoundCloud";
    frame.allow = "autoplay; encrypted-media";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    const params = new URLSearchParams({ url: TRACKS[index].url, ...WIDGET_OPTIONS });
    frame.src = `https://w.soundcloud.com/player/?${params}`;
    document.body.append(frame);
    widget = window.SC.Widget(frame);
    bind();
  }

  function start() {
    render(wanted ? "loading" : "paused");
    showTrack();
    if (wanted) watchLoading();
    if (window.SC?.Widget) {
      createWidget();
      return;
    }
    sdk = document.createElement("script");
    sdk.src = "https://w.soundcloud.com/player/api.js";
    sdk.async = true;
    sdk.onload = () => (window.SC?.Widget ? createWidget() : render("error"));
    sdk.onerror = () => { clearTimeout(timeout); render("error"); };
    document.head.append(sdk);
  }

  // Loads track `next` (wrapping around the list) and plays it if music is on.
  function go(next) {
    index = (next + TRACKS.length) % TRACKS.length;
    storage.set("music-track", String(index));
    showTrack();
    if (!widget) {
      start();
      return;
    }
    ready = false;
    if (wanted) {
      render("loading");
      watchLoading();
    }
    const token = ++loadToken;
    widget.load(TRACKS[index].url, {
      ...WIDGET_OPTIONS,
      callback: () => {
        if (token === loadToken) onLoaded();
      },
    });
  }

  function setWanted(value) {
    wanted = value;
    storage.set("music-off", value ? "0" : "1");
  }

  // The play / pause button: also retries after every track failed.
  function toggle() {
    if (button.dataset.state === "error") {
      failuresInARow = 0;
      setWanted(true);
      if (widget) go(index);
      else start();
      return;
    }
    if (wanted) {
      setWanted(false);
      clearTimeout(timeout);
      if (ready) widget.pause();
      render("paused");
    } else {
      setWanted(true);
      if (!widget) {
        start();
      } else if (ready) {
        render("loading");
        watchLoading();
        widget.play();
      } else {
        go(index);
      }
    }
  }

  // A track picked in the list plays right away; picking the current one pauses or resumes it.
  function choose(trackIndex) {
    if (trackIndex === index && button.dataset.state !== "error") {
      toggle();
      return;
    }
    failuresInARow = 0;
    setWanted(true);
    go(trackIndex);
  }

  /* ---------- events ---------- */
  button.addEventListener("click", toggle);
  $("music-next").addEventListener("click", () => { failuresInARow = 0; go(index + 1); });
  $("music-prev").addEventListener("click", () => { failuresInARow = 0; go(index - 1); });
  pickButton.addEventListener("click", () => (list.hidden ? openList() : closeList()));
  tracksEl.addEventListener("click", (event) => {
    const pick = event.target.closest(".track");
    if (pick) choose(Number(pick.dataset.index));
  });
  // Up / down move through the tracks; Home / End jump to the first and last.
  tracksEl.addEventListener("keydown", (event) => {
    const buttons = trackButtons();
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, to))].focus();
  });
  // Escape closes the list first (and stops there, so it does not also close search results).
  player.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      closeList({ restoreFocus: true });
    }
  });
  player.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !player.contains(event.relatedTarget)) closeList();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!list.hidden && !player.contains(event.target)) closeList();
  });
  $("music-open").addEventListener("click", () => {
    const url = TRACKS[index].url;
    if (window.downloader?.openExternal) window.downloader.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });

  window.addEventListener("beforeunload", () => {
    clearTimeout(timeout);
    frame?.remove();
    sdk?.remove();
  });
  buildList();
  start();
})();
