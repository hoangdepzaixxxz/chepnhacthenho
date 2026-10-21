(() => {
  const TRACK_URL = "https://soundcloud.com/hoangvanbaoviet2008/nha-c-remix-tiktok-2026-bxh?si=c1a2f18b31cf466087ae90efd78f426e&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing";
  const button = document.getElementById("music-toggle");
  const status = document.getElementById("music-status");
  let widget;
  let frame;
  let sdk;
  let ready = false;
  let wanted = true;
  let generation = 0;
  let timeout;

  function render(state) {
    const labels = {
      loading: "Đang tải nhạc nền · Bấm để tắt",
      playing: "Tắt nhạc nền",
      paused: "Bật nhạc nền",
      error: "Không tải được nhạc · Bấm để thử lại",
    };
    button.dataset.state = state;
    button.title = labels[state];
    button.setAttribute("aria-label", labels[state]);
    button.setAttribute("aria-pressed", String(state === "playing"));
    button.setAttribute("aria-busy", String(state === "loading"));
    status.textContent = labels[state];
  }

  function dispose() {
    generation += 1;
    clearTimeout(timeout);
    if (widget) {
      for (const event of Object.values(window.SC.Widget.Events)) widget.unbind(event);
    }
    frame?.remove();
    sdk?.remove();
    widget = frame = sdk = null;
    ready = false;
  }

  function fail() {
    dispose();
    wanted = false;
    render("error");
  }

  function watchLoading() {
    clearTimeout(timeout);
    timeout = setTimeout(fail, 30000);
  }

  function connect(token) {
    if (token !== generation) return;
    frame = document.createElement("iframe");
    frame.className = "music-player";
    frame.title = "Nhạc nền SoundCloud";
    frame.allow = "autoplay";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    const params = new URLSearchParams({
      url: TRACK_URL,
      auto_play: "false",
      show_artwork: "false",
      show_comments: "false",
      show_user: "false",
      sharing: "false",
      buying: "false",
      download: "false",
    });
    frame.src = `https://w.soundcloud.com/player/?${params}`;
    frame.style.cssText = "position:fixed!important;top:-9999px!important;left:-9999px!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;border:none!important;";
    document.body.append(frame);
    widget = window.SC.Widget(frame);
    const events = window.SC.Widget.Events;
    widget.bind(events.READY, () => {
      if (token !== generation) return;
      ready = true;
      widget.setVolume(40);
      if (wanted) {
        watchLoading();
        widget.play();
      } else {
        clearTimeout(timeout);
        render("paused");
      }
    });
    widget.bind(events.PLAY, () => {
      if (token !== generation) return;
      clearTimeout(timeout);
      if (!wanted) {
        widget.pause();
        return;
      }
      render("playing");
    });
    widget.bind(events.PAUSE, () => {
      if (token === generation && !wanted) render("paused");
    });
    widget.bind(events.FINISH, () => {
      if (token !== generation) return;
      clearTimeout(timeout);
      wanted = false;
      render("paused");
    });
    widget.bind(events.ERROR, () => {
      if (token === generation) fail();
    });
  }

  function start() {
    dispose();
    wanted = true;
    render("loading");
    watchLoading();
    const token = generation;
    if (window.SC?.Widget) {
      connect(token);
      return;
    }
    sdk = document.createElement("script");
    sdk.src = "https://w.soundcloud.com/player/api.js";
    sdk.async = true;
    sdk.onload = () => {
      if (token !== generation) return;
      if (window.SC?.Widget) connect(token);
      else fail();
    };
    sdk.onerror = () => { if (token === generation) fail(); };
    document.head.append(sdk);
  }

  button.addEventListener("click", () => {
    if (wanted) {
      wanted = false;
      clearTimeout(timeout);
      if (ready) widget.pause();
      else dispose();
      render("paused");
    } else if (ready) {
      wanted = true;
      render("loading");
      watchLoading();
      widget.play();
    } else {
      start();
    }
  });

  window.addEventListener("beforeunload", dispose);
  start();
})();
