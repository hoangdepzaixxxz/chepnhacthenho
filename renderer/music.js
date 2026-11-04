// Background music: a short list of recent Vietnamese chill tracks played through the
// SoundCloud widget, with previous / play-pause / next controls in the top bar.
(() => {
  // Chosen 2026-11-04: uploaded May–Sep 2026, embeddable, fully playable (not 30 s previews)
  // and streamed without DRM, which Electron cannot decode.
  const TRACKS = [
    { title: "Không Thành (Indie Chill)", artist: "Hyden Tran", url: "https://soundcloud.com/hydentran666/tama-kh-ng-th-nh-indie-chill" },
    { title: "Đi Cùng Anh (Deep Chill)", artist: "Minh Nguyen", url: "https://soundcloud.com/minh-nguyen-369100723/i-c-ng-anh-2026-version" },
    { title: "Phía Sau Em (VietChill)", artist: "VanhPumpkin", url: "https://soundcloud.com/vi-t-anh-165899236/phia-sau-em-vietchill" },
    { title: "Đành Quên (MGM Cover)", artist: "MarchGMusic", url: "https://soundcloud.com/marchgmusic/nh-qu-n-tony-vi-t-mgm-cover" },
    { title: "Chẳng Cần Bình Yên (Indie Deep Chill)", artist: "Hyden Tran", url: "https://soundcloud.com/hydentran666/ch-ng-c-n-b-nh-y-n-indie-deep" },
    { title: "Vừa Hận Vừa Yêu (VietChill)", artist: "Thịnh Trần", url: "https://soundcloud.com/th-nh-tr-n-974609807/v-a-h-n-v-a-y-u-vietchill" },
    { title: "Biết Nói Là Tại Sao (Lofi Ver.)", artist: "Shen", url: "https://soundcloud.com/c-u-v-ng-909591098/bi-t-n-i-l-t-i-sao-lofi-ver-kh" },
    { title: "Một Người Luôn Yêu Em Đấy (Indie Chill)", artist: "Hyden Tran", url: "https://soundcloud.com/hydentran666/m-t-ng-i-lu-n-y-u-em-y-indie" },
    { title: "Có Công Mài Sắc (Lofi Chill)", artist: "Huy Nhật", url: "https://soundcloud.com/huy-nh-t-873065339/c-c-ng-m-i-s-c-lofi-chill" },
    { title: "Thì Quá Khứ (Indie Jersey Chill)", artist: "Hyden Tran", url: "https://soundcloud.com/hydentran666/th-qu-kh-indie-jersey-chill" },
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

  const $ = (id) => document.getElementById(id);
  const button = $("music-toggle");
  const status = $("music-status");
  const titleEl = $("music-title");
  const artistEl = $("music-artist");
  const cover = $("music-cover");
  const coverBlank = $("music-cover-blank");

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

  function render(state) {
    button.dataset.state = state;
    button.title = LABELS[state];
    button.setAttribute("aria-label", LABELS[state]);
    button.setAttribute("aria-pressed", String(state === "playing"));
    status.textContent = state === "playing" ? `Đang phát ${TRACKS[index].title}` : LABELS[state];
  }

  function showTrack(sound) {
    const track = TRACKS[index];
    titleEl.textContent = track.title;
    artistEl.textContent = `${track.artist} · ${index + 1}/${TRACKS.length}`;
    const artwork = sound?.artwork_url || sound?.user?.avatar_url || "";
    if (/^https:\/\/[a-z0-9.-]+\.sndcdn\.com\//.test(artwork)) {
      cover.src = artwork.replace("-large.", "-t67x67.");
      cover.hidden = false;
      coverBlank.hidden = true;
    } else {
      cover.hidden = true;
      coverBlank.hidden = false;
    }
  }

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
      showTrack(sound);
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
    showTrack(null);
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
    showTrack(null);
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

  button.addEventListener("click", () => {
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
  });
  $("music-next").addEventListener("click", () => { failuresInARow = 0; go(index + 1); });
  $("music-prev").addEventListener("click", () => { failuresInARow = 0; go(index - 1); });
  $("music-link").addEventListener("click", () => {
    const url = TRACKS[index].url;
    if (window.downloader?.openExternal) window.downloader.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });

  window.addEventListener("beforeunload", () => {
    clearTimeout(timeout);
    frame?.remove();
    sdk?.remove();
  });
  start();
})();
