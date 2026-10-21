"use strict";
const $ = (id) => document.getElementById(id);
const RATES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
const PAUSE_GRACE_SEC = 90; // paused time that still counts as studying (notes, rewinds)
const HEARTBEAT_SEC = 10;

let S = null;          // last /api/state response
let flat = [];         // items in study order
let blockId = localStorage.getItem("vidanki.block") || "";
let curId = null;
let view = "item";     // "item" | "gate"
let gateFor = null;    // title of the video whose cards the gate is waiting on
let loadedVideoId = null;
let renderer = null;

// ---------- helpers ----------
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const hrs = (s) => (s / 3600).toFixed(1) + " h";
function mins(s) {
  const m = Math.round(s / 60);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}
function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}
const estTotal = (it) => { const e = it.est || {}; return (e.video || 0) + (e.anki || 0) + (e.other || 0); };
const cur = () => flat.find((i) => i.id === curId);
function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.textContent = ""), 9000);
}
function nextPending(fromId) {
  const i = flat.findIndex((x) => x.id === fromId);
  return flat.slice(i + 1).find((x) => !x.done) || flat.find((x) => !x.done && x.id !== fromId);
}

// ---------- load & render ----------
async function load() {
  S = await api("/api/state" + (blockId ? "?block=" + encodeURIComponent(blockId) : ""));
  blockId = S.block.id;
  flat = S.clusters.flatMap((c) => c.items.map((i) => ({ ...i, cluster: c.title })));
  if (!curId || !cur()) {
    curId = (S.current && flat.some((i) => i.id === S.current && !i.done) && S.current) ||
      (flat.find((i) => !i.done) || flat[0]).id;
  }
  render();
}

function render() {
  renderBlocks();
  renderStats();
  renderQueue();
  renderEstimates();
  const dot = $("ankiDot");
  dot.className = "anki-dot" + (S.anki.ok ? " ok" : "");
  dot.title = S.anki.ok ? "Anki connected" : "Anki not running (cards get unsuspended once it's open)";
  if (view === "gate") renderGate();
  else if (view === "anki") renderAnkiPanel();
  else showItem(curId);
}

const blockDD = new Dropdown($("blockDD"), { onChange: (v) => switchBlock(v) });
function renderBlocks() {
  if (blockDD.options.length !== S.blocks.length) {
    blockDD.setOptions(S.blocks.map((b) => ({ value: b.id, label: b.name })));
  }
  blockDD.setValue(S.block.id);
}
function switchBlock(id) {
  flushTime();
  blockId = id;
  localStorage.setItem("vidanki.block", blockId);
  curId = null;
  view = "item";
  load();
}

function stat(k, v, cls = "", bar = null, title = "") {
  return `<div class="stat" title="${title}"><span class="k">${k}</span><span class="v ${cls}">${v}</span>` +
    (bar === null ? "" : `<div class="bar"><div style="width:${Math.min(100, bar * 100).toFixed(1)}%"></div></div>`) + "</div>";
}

function renderStats() {
  const st = S.stats;
  const goal = new Date(S.block.goalDate + "T12:00");
  const goalStr = goal.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const w = st.work;
  let pace = "—", paceCls = "";
  if (st.paceSec) {
    const p = new Date(st.projectedFinish + "T12:00");
    pace = `${hrs(st.paceSec)}/day → ${p.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    paceCls = p > goal ? "bad" : "good";
  }
  // three groups: overall progress | the goal and what it takes | today
  const group = (cls, ...stats) => `<div class="stat-group ${cls}">${stats.join("")}</div>`;
  $("stats").innerHTML = [
    group("", stat("Done", `${st.items.done} / ${st.items.count}`, "", st.items.done / st.items.count,
      `${st.items.videosDone}/${st.items.videos} videos`)),
    group("goal clickable",
      stat("Goal", `${goalStr} · ${st.daysLeft} d`),
      stat("Work left", "≈ " + hrs(st.remainingSec), "", null,
        `Videos ${hrs(w.video)} · New cards ${hrs(w.newCards)} · Reviews ${hrs(w.reviews)} · Bricks ${hrs(w.bricks)} · AMBOSS ${hrs(w.amboss)}`),
      stat("Needed", `${hrs(st.perDaySec)}/day`)),
    group("",
      stat("Today", `${hrs(st.todaySec)} / ${hrs(st.todayNeededSec)}`, "", st.todaySec / st.todayNeededSec),
      stat("Pace", pace, paceCls, null, "Average of the last 3 days you studied → projected finish")),
  ].join("");
  const goalGroup = $("stats").querySelector(".goal");
  goalGroup.title = "Change goal date and estimates";
  goalGroup.onclick = openSettings;
  if (!$("settingsModal").hidden) renderSettingsResult();
}

function todaySet() {
  // Pending items that fit in what's left of today's target, in order.
  const left = S.stats.todayNeededSec - S.stats.todaySec;
  const out = new Set();
  // today's share of reviews comes first, then open-batch new cards, then items in order
  let acc = S.stats.todayAnkiSec;
  for (const it of flat) {
    if (it.done) continue;
    if (acc >= left) break;
    out.add(it.id);
    acc += estTotal(it);
  }
  return out;
}

// Time an item took: what VidAnki tracked, or the estimate if it wasn't tracked here.
function timeTaken(i) {
  const r = S.stats.rates, act = i.activeSec || 0;
  if (i.type === "video") {
    const d = i.duration || 0;
    return act >= 0.2 * d && act > 0 ? act : d * (r.videoFactor[i.source] || 1);
  }
  if (act >= 60) return act;  // a few stray seconds isn't a real measurement
  return i.type === "brick" ? r.brickSec : (i.questions || 0) * r.ambossSecPerQ;
}

function renderQueue() {
  const hide = $("hideDone").checked;
  const today = todaySet();
  let html = "";
  const a = S.stats.ankiNow;
  // Anki row: only when there's a real chunk of cards (or a video is waiting on them)
  if (S.anki.ok && (a.sec >= a.minSec || S.anki.gate)) {
    const parts = [a.due && `${a.due} review${a.due === 1 ? "" : "s"}`, a.new && `${a.new} new`].filter(Boolean);
    html += `<div class="cluster today-anki"><div class="cluster-title"><span>Anki</span><span>${mins(a.sec)}</span></div>
      <div class="qi today ${view === "anki" ? "current" : ""}" data-id="__anki" title="VidAnki deck: due reviews and new cards">
        <span class="chk"></span><span class="qt"><span class="tag anki">ANKI</span>${parts.join(" · ") || "Cards waiting"}</span>
        <span class="qm">${mins(a.sec)}</span></div></div>`;
  }
  for (const c of S.clusters) {
    const items = c.items.filter((i) => !hide || !i.done || i.id === curId);
    if (!items.length) continue;
    const left = c.items.filter((i) => !i.done).reduce((a, i) => a + estTotal(i), 0);
    const nDone = c.items.filter((i) => i.done).length;
    let meta = left ? mins(left) : "✓", metaTip = "Time left";
    if (!hide && nDone === c.items.length) {  // finished section: how long it took
      meta = `✓ ${mins(c.items.reduce((a, i) => a + timeTaken(i), 0))}`;
      metaTip = "Total time (tracked, or estimated where VidAnki didn't track it)";
    } else if (!hide) {
      const spent = c.items.filter((i) => i.done).reduce((a, i) => a + timeTaken(i), 0);
      meta = `${nDone}/${c.items.length} · ` + (nDone ? `${mins(spent)} / ${mins(spent + left)}` : mins(left));
      metaTip = "Items done / total · time done / total time";
    }
    html += `<div class="cluster"><div class="cluster-title"><span>${c.title}</span><span title="${metaTip}">${meta}</span></div>`;
    for (const i of items) {
      const tag = i.type === "video" ? (i.source === "bnb" ? "B&B" : "SK") : i.type === "brick" ? "BRX" : "AMB";
      const cls = i.type === "video" ? i.source : i.type;
      let meta = mins(i.done ? timeTaken(i) : estTotal(i));
      let title = "";
      if (i.type === "video" && i.est) {
        title = `Video ${mins(i.est.video || 0)} + Anki ${mins(i.est.anki || 0)} (${i.est.cards || 0} HY cards)`;
        if (i.missing) meta = "missing";
      }
      html += `<div class="qi ${i.done ? "done" : ""} ${i.id === curId && view !== "anki" ? "current" : ""} ${today.has(i.id) ? "today" : ""}" data-id="${i.id}" title="${title}">
        <span class="chk">${i.done ? "✓" : ""}</span>
        <span class="qt"><span class="tag ${cls}">${tag}</span>${i.title.replace(/^Sketchy (Micro|Pharm): /, "")}</span>
        <span class="qm">${meta}</span></div>`;
    }
    html += "</div>";
  }
  $("queueList").innerHTML = html;
  syncQueue();
}

const TIER_LABELS = { 1: "High yield", 2: "Relatively high yield", 3: "High yield (temporary)" };
function renderEstimates() {
  const st = S.stats, r = st.rates, w = st.work, c = st.cards;
  const pending = flat.filter((i) => !i.done);
  const vidLeft = pending.filter((i) => i.type === "video").reduce((s, i) => s + Math.max((i.duration || 0) - (i.pos || 0), 0), 0);
  const bricks = pending.filter((i) => i.type === "brick").length;
  const aq = pending.filter((i) => i.type === "amboss").reduce((s, i) => s + (i.questions || 0), 0);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const row = (k, amount, rate, sec, tip = "") =>
    `<tr title="${tip}"><td>${k}</td><td>${amount}</td><td>${rate}</td><td>${hrs(sec)}</td></tr>`;
  $("estBody").innerHTML = `<table class="est-table">
    <thead><tr><th></th><th>Left</th><th>Each</th><th>Time</th></tr></thead>
    <tbody>
    ${row("Videos", mins(vidLeft), `${r.videoFactor.bnb.toFixed(1)}× / ${r.videoFactor.sketchy.toFixed(1)}×`, w.video, "B&B / Sketchy time per minute of video")}
    ${row("New cards", c.newLeft, `${Math.round(r.cardSec)} s`, w.newCards, c.waitingNew ? `incl. ${c.waitingNew} already unsuspended in your decks` : "")}
    ${row("Reviews", c.existingReviews + Math.round(c.freshReviews), `${r.reviewSec} s`, w.reviews, `${c.existingReviews} scheduled before the goal + ~${Math.round(c.freshReviews)} from new cards`)}
    ${row("Bricks", bricks, mins(r.brickSec), w.bricks)}
    ${row("AMBOSS", `${aq} Q`, `${(r.ambossSecPerQ / 60).toFixed(1)} min`, w.amboss)}
    </tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td>${hrs(total)}</td></tr></tfoot>
  </table>
  <div class="est-sub">Unsuspend</div>
  <div class="tiers">
    ${Object.entries(TIER_LABELS).map(([t, label]) =>
      `<label class="check"><input type="checkbox" data-tier="${t}" ${c.tiers.includes(t) ? "checked" : ""}><span></span>${label}</label>`).join("")}
  </div>
  <div class="est-notes">
    <div>Rates adapt as you study. Card time = Anki log × ${r.revlogOverhead.toFixed(1)}.</div>
    <div><span class="today-dot"></span>= fits in today's target</div>
  </div>`;
  $("estBody").querySelectorAll("[data-tier]").forEach((el) => (el.onchange = setTiers));
}
// Keep the selected row in view and Prev/Next enabled only when they can move.
let scrolledTo = null;
function syncQueue() {
  setTimeout(() => {  // after the DOM update (not rAF: it pauses in background tabs)
    const key = view === "anki" ? "__anki" : curId;
    const el = document.querySelector(`.qi[data-id="${key}"]`);
    if (el && key !== scrolledTo) {
      const q = $("queue").getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < q.top + 40 || r.bottom > q.bottom - 8) el.scrollIntoView({ block: "center" });  // only if off-screen
      scrolledTo = key;
    }
    if (!S) return;
    const order = queueOrder(), at = order.indexOf(key);
    $("prevBtn").disabled = at <= 0;
    $("nextBtn").disabled = at < 0 || at >= order.length - 1;
  }, 0);
}
async function setTiers() {
  const tiers = [...$("estBody").querySelectorAll("[data-tier]:checked")].map((el) => el.dataset.tier);
  await api("/api/settings", { tiers });
  await load();
}

// ---------- item views ----------
function showItem(id) {
  const it = flat.find((i) => i.id === id);
  if (!it) return;
  if (id !== curId) flushTime();
  curId = id;
  view = "item";
  $("gate").hidden = true;
  $("ankiPanel").hidden = true;
  $("crumbs").textContent = `${S.block.name} · ${it.cluster}`;
  $("itemTitle").textContent = it.title;
  $("itemNote").hidden = !it.note;
  $("itemNote").textContent = it.note || "";
  $("doneBtn").hidden = it.done;
  $("undoneBtn").hidden = !it.done;
  $("doneBtn").textContent = it.type === "video" && it.est && it.est.cards
    ? `Mark done · unsuspend ${it.est.cards} cards` : "Mark done";
  const isVideo = it.type === "video";
  $("player").hidden = !isVideo;
  $("task").hidden = isVideo;
  if (isVideo) setupVideo(it);
  else { pauseVideo(); setupTask(it); }
  document.querySelectorAll(".qi").forEach((el) => el.classList.toggle("current", el.dataset.id === curId));
  syncQueue();
}

function setupTask(it) {
  const amb = it.type === "amboss";
  $("ambossFields").hidden = !amb;
  $("brickLink").hidden = amb || !it.url;
  if (it.url) $("brickLink").href = it.url;
  $("taskKind").textContent = amb ? "AMBOSS questions" : "ScholarRx brick · end questions";
  $("taskInstr").hidden = !amb;
  $("taskInstr").textContent = amb ? `${it.questions} recommended` : "";
  if (timer.id !== it.id) {  // first time showing this item (polling re-renders must not wipe input)
    timer.running = false;
    timer.id = it.id;
    timer.shown = it.activeSec || 0;
    $("ambN").value = (it.ambossLog && it.ambossLog.n) || "";
    $("ambC").value = (it.ambossLog && it.ambossLog.correct) || "";
  }
  updateTimer();
}

// ---------- video ----------
const video = $("video");
let endShown = false;
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const DARK_MODES = [
  { value: "auto", label: "Follow system", short: "Auto" },
  { value: "smart", label: "Smart dark", short: "Smart dark" },
  { value: "invert", label: "Invert", short: "Invert" },
  { value: "dim", label: "Dim", short: "Dim" },
  { value: "off", label: "Original", short: "Original" },
];
const rateDD = new Dropdown($("rateDD"), {
  options: RATES.map((r) => ({ value: String(r), label: r + "×" })),
  value: "1",
  onChange: (v) => setRate(parseFloat(v)),
});
const darkDD = new Dropdown($("darkDD"), { options: DARK_MODES, value: "auto", onChange: (v) => setDark(v) });

function darkSetting(it) { return ((S.settings.dark || {})[it.source]) || "auto"; }

function setupVideo(it) {
  if (loadedVideoId !== it.id) {
    loadedVideoId = it.id;
    endShown = false;
    $("endCard").hidden = true;
    video.src = `/media/${encodeURIComponent(blockId)}/${encodeURIComponent(it.id)}`;
    video.addEventListener("loadedmetadata", () => {
      if (it.pos > 5 && it.pos < video.duration - 20) video.currentTime = it.pos;
      video.playbackRate = S.settings.rate || 1;
    }, { once: true });
  }
  rateDD.setValue(S.settings.rate || 1);
  darkDD.setValue(darkSetting(it));
  applyDark(darkSetting(it));
}

function setDark(mode) {
  const it = cur();
  if (!it || it.type !== "video") return;
  S.settings.dark = { ...(S.settings.dark || {}), [it.source]: mode };
  darkDD.setValue(mode);
  applyDark(mode);
  api("/api/settings", { dark: S.settings.dark });
}

function applyDark(mode) {
  if (mode === "auto") mode = systemDark.matches ? "smart" : "off";
  const canvas = $("glcanvas");
  if (mode === "smart" && !renderer) {
    try { renderer = SmartDark.create(canvas, video); } catch (e) { console.error(e); }
    if (!renderer) mode = "invert";
  }
  canvas.hidden = mode !== "smart";
  if (mode === "smart") renderer.start(); else if (renderer) renderer.stop();
  video.style.filter = { invert: "invert(1) hue-rotate(180deg)", dim: "brightness(.78) contrast(1.05)" }[mode] || "";
}
systemDark.addEventListener("change", () => {
  const it = cur();
  if (it && it.type === "video") applyDark(darkSetting(it));
});

function pauseVideo() { if (!video.paused) video.pause(); }
function togglePlay() { if (video.paused) video.play(); else video.pause(); }
function setRate(r) {
  video.playbackRate = r;
  rateDD.setValue(r);
  S.settings.rate = r;
  api("/api/settings", { rate: r });
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen(); else $("stage").requestFullscreen();
}

$("playBtn").onclick = togglePlay;
$("back10").onclick = () => (video.currentTime -= 10);
$("fwd10").onclick = () => (video.currentTime += 10);
$("vol").oninput = (e) => { video.volume = +e.target.value; video.muted = false; };
$("fsBtn").onclick = toggleFullscreen;
$("seek").oninput = (e) => { if (video.duration) video.currentTime = (e.target.value / 1000) * video.duration; };
$("stage").addEventListener("click", (e) => {
  if (e.target === video || e.target === $("stage") || e.target === $("glcanvas")) togglePlay();
});
video.addEventListener("play", () => ($("playBtn").textContent = "❚❚"));
video.addEventListener("pause", () => ($("playBtn").textContent = "▶"));
video.addEventListener("timeupdate", () => {
  const d = video.duration || 0;
  $("time").textContent = `${clock(video.currentTime)} / ${clock(d)}` +
    (video.playbackRate !== 1 ? ` · ${clock((d - video.currentTime) / video.playbackRate)} left` : "");
  if (document.activeElement !== $("seek")) $("seek").value = d ? (video.currentTime / d) * 1000 : 0;
  if (d && !endShown && video.currentTime >= d - 12) showEndCard();
});
video.addEventListener("ended", showEndCard);

function showEndCard() {
  if (endShown) return;
  endShown = true;
  const it = cur();
  if (!it || it.done) return;
  const n = it.est && it.est.cards;
  $("endCardSub").textContent = n
    ? `Unsuspends ${n} cards.` : "";
  $("endCard").hidden = false;
  $("stage").classList.remove("idle");
}
$("endDone").onclick = () => { $("endCard").hidden = true; markDone(); };
$("endKeep").onclick = () => ($("endCard").hidden = true);

// Controls: hidden the moment playback starts; mouse movement shows them
// briefly; always shown while paused or while the pointer is on them.
let idleT, overControls = false;
function hideControls() {
  if (!video.paused && !overControls && !$("controls").querySelector(".dd.open")) $("stage").classList.add("idle");
}
function wake() {
  $("stage").classList.remove("idle");
  clearTimeout(idleT);
  idleT = setTimeout(hideControls, 1800);
}
$("stage").addEventListener("mousemove", wake);
$("controls").addEventListener("mouseenter", () => (overControls = true));
$("controls").addEventListener("mouseleave", () => { overControls = false; wake(); });
video.addEventListener("play", () => { clearTimeout(idleT); overControls = false; hideControls(); });
video.addEventListener("pause", () => { clearTimeout(idleT); $("stage").classList.remove("idle"); });

// ---------- brick/amboss timer ----------
const timer = { id: null, running: false, shown: 0 };
function updateTimer() {
  $("timerVal").textContent = clock(timer.shown);
  $("timerBtn").textContent = timer.running ? "Pause timer" : (timer.shown ? "Resume timer" : "Start timer");
  $("timerBtn").className = timer.running ? "t-pause" : "t-start";
}
$("timerBtn").onclick = () => { timer.running = !timer.running; updateTimer(); };
// Edit / reset. Typed values: "1:05:00", "12:30", or a plain number of minutes.
function parseDuration(text) {
  text = text.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return parseFloat(text) * 60;
  const parts = text.split(":").map(Number);
  if (parts.some(isNaN) || parts.length > 3) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
async function setTimerTo(sec) {
  const it = cur();
  if (!it) return;
  pending = 0;  // the new value replaces whatever hadn't been sent yet
  timer.shown = sec;
  updateTimer();
  try {
    await api("/api/set-time", { block: blockId, id: it.id, sec });
    it.activeSec = sec;
  } catch (e) { toast(e.message, true); }
}
function editTimer() {
  const input = $("timerEdit");
  input.value = clock(timer.shown);
  $("timerVal").hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}
function closeTimerEdit() { $("timerEdit").hidden = true; $("timerVal").hidden = false; }
$("timerVal").onclick = editTimer;
$("timerEditBtn").onclick = editTimer;
$("timerEdit").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const sec = parseDuration(e.target.value);
    if (sec === null) { toast("Use m:ss, h:mm:ss, or a number of minutes", true); return; }
    closeTimerEdit();
    setTimerTo(sec);
  } else if (e.key === "Escape") { e.stopPropagation(); closeTimerEdit(); }
});
$("timerEdit").addEventListener("blur", closeTimerEdit);
let resetArmed = null;
$("timerReset").onclick = () => {
  const btn = $("timerReset");
  if (!resetArmed) {  // two clicks, so a stray one doesn't wipe the time
    btn.textContent = "Confirm reset";
    btn.classList.add("confirm");
    resetArmed = setTimeout(() => { resetArmed = null; btn.textContent = "Reset"; btn.classList.remove("confirm"); }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  btn.textContent = "Reset";
  btn.classList.remove("confirm");
  timer.running = false;
  setTimerTo(0);
};

// Opening the brick or AMBOSS starts the timer (it keeps running while you're in that tab).
function startTimer() { if (!timer.running) { timer.running = true; updateTimer(); } }
$("brickLink").addEventListener("click", startTimer);
$("ambLink").addEventListener("click", startTimer);

// ---------- active-time tracking ----------
let pending = 0, pauseRun = 0, sinceFlush = 0, last = performance.now(), playedThisItem = false;
video.addEventListener("playing", () => (playedThisItem = true));
setInterval(() => {
  // Chrome ticks background tabs only about once a minute, so allow long gaps;
  // the cap only guards against counting a sleeping Mac.
  const now = performance.now(), dt = Math.min((now - last) / 1000, 90);
  last = now;
  const it = cur();
  if (!it || view !== "item") return;
  if (it.type === "video") {
    if (!video.paused) { pending += dt; pauseRun = 0; }
    else if (playedThisItem && (pauseRun += dt) <= PAUSE_GRACE_SEC) pending += dt;
  } else if (timer.running) {
    pending += dt;
    timer.shown += dt;
    updateTimer();
  }
  if ((sinceFlush += dt) >= HEARTBEAT_SEC) flushTime();
}, 1000);

function flushTime(beacon = false) {
  sinceFlush = 0;
  const it = cur();
  if (!it) return;
  const body = { block: blockId, id: it.id, delta: pending };
  if (it.type === "video" && loadedVideoId === it.id && video.currentTime) body.pos = video.currentTime;
  if (!body.delta && body.pos === undefined) return;
  pending = 0;
  if (beacon) navigator.sendBeacon("/api/heartbeat", new Blob([JSON.stringify(body)], { type: "application/json" }));
  else api("/api/heartbeat", body).catch(() => {});
}
window.addEventListener("pagehide", () => flushTime(true));

// ---------- done / next / gate ----------
async function markDone() {
  const it = cur();
  if (!it) return;
  flushTime();
  const body = { block: blockId, id: it.id };
  if (it.type === "amboss") {
    body.amboss = { n: parseInt($("ambN").value) || it.questions, correct: parseInt($("ambC").value) || null };
  }
  timer.running = false;
  $("doneBtn").disabled = true;
  try {
    const r = await api("/api/done", body);
    pauseVideo();
    const parts = [];
    if (r.renamed) parts.push(`Renamed → ${r.renamed}`);
    if (r.batch) {
      if (r.batch.needsAnki) parts.push("Anki isn't open: cards will be unsuspended once it is");
      else parts.push(`Unsuspended ${r.batch.unsuspended} · ${r.batch.newCards} new cards in “${S.anki.deck}”`);
    }
    toast(parts.join(" · ") || "Done");
    await load();
    if (S.anki.gate) { gateFor = S.anki.gate.title; view = "gate"; renderGate(); }
    else goNext();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $("doneBtn").disabled = false;
  }
}

function goNext() {
  const n = nextPending(curId);
  if (!n) { toast("Everything in this block is done 🎉"); return; }
  if (S.anki.gate && n.type === "video") { gateFor = S.anki.gate.title; view = "gate"; renderGate(); return; }
  showItem(n.id);
  renderQueue();
}

function renderGate() {
  flushTime();
  pauseVideo();
  $("ankiPanel").hidden = true;
  $("player").hidden = true;
  $("task").hidden = true;
  $("gate").hidden = false;
  $("doneBtn").hidden = true;
  $("undoneBtn").hidden = true;
  $("itemNote").hidden = true;
  $("crumbs").textContent = S.block.name;
  $("itemTitle").textContent = "Do the new Anki cards";
  const g = S.anki.gate, next = nextPending(curId);
  const nextTitle = next ? next.title : "nothing left";
  if (!g) {
    $("gateText").innerHTML = `All new cards from <b>${gateFor || "the last video"}</b> done.`;
    $("gateBar").style.width = "100%";
    $("gateSub").textContent = "";
    $("gateNext").hidden = !next;
    $("gateNext").textContent = `Continue: ${nextTitle} ▸`;
    $("gateSkip").hidden = true;
    return;
  }
  $("gateSkip").hidden = false;
  $("gateNext").hidden = true;
  if (g.needsAnki) {
    $("gateText").innerHTML = `Waiting for Anki to unsuspend <b>${g.title}</b>'s cards.`;
    $("gateBar").style.width = "0%";
    $("gateSub").textContent = "Waiting for Anki…";
    return;
  }
  const done = g.total - g.newLeft;
  $("gateText").innerHTML = `<b>${g.newLeft}</b> of ${g.total} new cards left · ${g.title}`;
  $("gateBar").style.width = (g.total ? (done / g.total) * 100 : 100) + "%";
  $("gateSub").textContent = [
    g.learning ? `${g.learning} in learning` : "",
    g.openBatches > 1 ? `${g.openBatches} videos' cards are still open` : "",
    g.deckError ? `Couldn't build the filtered deck (${g.deckError}). Restart Anki once so the VidAnki bridge add-on loads; until then study them in your normal deck.` : "",
    `Next: ${nextTitle}`,
  ].filter(Boolean).join(" · ");
}

function showAnki() {
  flushTime();
  view = "anki";
  renderAnkiPanel();
  renderQueue();
}
function renderAnkiPanel() {
  pauseVideo();
  ["player", "task", "gate"].forEach((id) => ($(id).hidden = true));
  $("ankiPanel").hidden = false;
  $("doneBtn").hidden = true;
  $("undoneBtn").hidden = true;
  $("itemNote").hidden = true;
  $("crumbs").textContent = `${S.block.name} · Anki`;
  $("itemTitle").textContent = "Today's Anki";
  const a = S.stats.ankiNow, r = S.stats.rates, g = S.anki.gate;
  $("ankiLabel").textContent = `In the ${S.anki.deck} deck`;
  const rows = [
    ["Reviews due now", a.due, r.reviewSec],
    ["New cards from finished videos", a.new, r.cardSec],
  ];
  $("ankiTable").innerHTML = `<thead><tr><th></th><th>Cards</th><th>Each</th><th>Time</th></tr></thead><tbody>` +
    rows.map(([k, n, sec]) => `<tr><td>${k}</td><td>${n}</td><td>${Math.round(sec)} s</td><td>${mins(n * sec)}</td></tr>`).join("") +
    `</tbody><tfoot><tr><td>Total</td><td>${a.due + a.new}</td><td></td><td>${mins(a.sec)}</td></tr></tfoot>`;
  $("ankiSub").innerHTML = [
    g ? `<b>${g.newLeft}</b> new from <b>${g.title}</b> left before the next video.` : "",
    "Learning cards return later today; small leftovers hide from the queue.",
  ].filter(Boolean).map((t) => `<p>${t}</p>`).join("");
}
$("ankiOpen").onclick = () => api("/api/open-anki", {}).catch((e) => toast(e.message, true));
$("ankiRebuild").onclick = async () => {
  try { const r = await api("/api/rebuild-deck", {}); toast(`VidAnki deck: ${r.cards} cards`); await load(); }
  catch (e) { toast(e.message, true); }
};
$("gateOpen").onclick = () => api("/api/open-anki", {}).catch((e) => toast(e.message, true));
$("gateSkip").onclick = async () => {
  await api("/api/skip-gate", { block: blockId });
  await load();
  view = "item";
  const n = nextPending(curId);
  if (n) showItem(n.id);
};
$("gateNext").onclick = () => {
  view = "item";
  const n = nextPending(curId);
  if (n) showItem(n.id);
};

$("doneBtn").onclick = markDone;
$("undoneBtn").onclick = async () => {
  try {
    await api("/api/undone", { block: blockId, id: curId });
    toast("Marked not done (file renamed back; cards stay unsuspended)");
    await load();
  } catch (e) { toast(e.message, true); }
};
$("nextBtn").onclick = () => step(1);
// Prev/Next walk exactly what the queue shows: the Anki row (when shown), then
// items, skipping done ones while "hide done" is on.
function ankiRowShown() {
  const a = S.stats.ankiNow;
  return S.anki.ok && (a.sec >= a.minSec || !!S.anki.gate);
}
function queueOrder() {
  const hide = $("hideDone").checked;
  const ids = flat.filter((i) => !hide || !i.done || i.id === curId).map((i) => i.id);
  return ankiRowShown() ? ["__anki", ...ids] : ids;
}
function step(dir) {
  const order = queueOrder();
  const at = order.indexOf(view === "anki" ? "__anki" : curId);
  const id = order[at + dir];
  if (id === undefined) return;  // already at the end; the button is disabled there
  if (id === "__anki") { showAnki(); return; }
  const it = flat.find((x) => x.id === id);
  if (dir > 0 && S.anki.gate && it.type === "video" && !it.done) {
    gateFor = S.anki.gate.title; view = "gate"; renderGate(); return;
  }
  view = "item";
  showItem(id);
  renderQueue();
}
const goPrev = () => step(-1);
$("prevBtn").onclick = goPrev;
$("queueList").onclick = (e) => {
  const el = e.target.closest(".qi");
  if (!el) return;
  if (el.dataset.id === "__anki") { showAnki(); return; }
  view = "item";
  showItem(el.dataset.id);
  renderQueue();
};
$("hideDone").onchange = renderQueue;

// ---------- settings ----------
const PIN_FIELDS = [
  { key: "bnbFactor", label: "B&B video time", unit: "× length", get: (r) => r.videoFactor.bnb, scale: 1, dp: 2 },
  { key: "sketchyFactor", label: "Sketchy video time", unit: "× length", get: (r) => r.videoFactor.sketchy, scale: 1, dp: 2 },
  { key: "cardSec", label: "New card, incl. reading & re-reviewing", unit: "s", get: (r) => r.cardSec, scale: 1, dp: 0 },
  { key: "reviewSec", label: "Review card", unit: "s", get: (r) => r.reviewSec, scale: 1, dp: 0 },
  { key: "brickSec", label: "Brick end-questions", unit: "min", get: (r) => r.brickSec, scale: 60, dp: 1 },
  { key: "ambossSecPerQ", label: "AMBOSS per question, incl. explanation", unit: "min", get: (r) => r.ambossSecPerQ, scale: 60, dp: 1 },
];
function openSettings() {
  openModal("settingsModal");
  renderSettings();
}
function renderSettings() {
  const r = S.stats.rates;
  $("setBlockName").textContent = S.block.name;
  $("setGoal").value = S.block.goalDate;
  $("setPins").innerHTML = PIN_FIELDS.map((f) => {
    const pinned = r.pinned.includes(f.key);
    const v = (f.get(r) / f.scale).toFixed(f.dp);
    return `<div class="set-row ${pinned ? "pinned" : ""}" data-key="${f.key}">
      <label>${f.label}</label>
      <input type="number" step="any" min="0" ${pinned ? `value="${v}"` : `placeholder="${v}"`}>
      <span class="unit">${f.unit}</span>
      <button class="ghost reset" title="Go back to the learned value">reset</button></div>`;
  }).join("");
  $("setPins").querySelectorAll(".set-row").forEach((row) => {
    const f = PIN_FIELDS.find((x) => x.key === row.dataset.key);
    const input = row.querySelector("input");
    input.onchange = () => savePin(f, input.value === "" ? null : parseFloat(input.value) * f.scale);
    row.querySelector(".reset").onclick = () => savePin(f, null);
  });
  $("setTiers").innerHTML = Object.entries(TIER_LABELS).map(([t, label]) =>
    `<label class="check"><input type="checkbox" data-tier="${t}" ${S.stats.cards.tiers.includes(t) ? "checked" : ""}><span></span>Unsuspend ${label.toLowerCase()} cards</label>`).join("");
  const rev = S.settings.reviewsInDeck !== false;
  $("setTiers").insertAdjacentHTML("beforeend",
    `<label class="check"><input type="checkbox" id="setReviewsInDeck" ${rev ? "checked" : ""}><span></span>Also put today's due AnKing reviews in the VidAnki deck</label>`);
  $("setReviewsInDeck").onchange = async (e) => {
    await api("/api/settings", { reviewsInDeck: e.target.checked });
    await api("/api/rebuild-deck", {}).catch((err) => toast(err.message, true));
    await load();
    toast(e.target.checked ? "VidAnki deck now includes today's AnKing reviews" : "Reviews left in your AnKing deck");
  };
  $("setTiers").querySelectorAll("[data-tier]").forEach((el) => (el.onchange = async () => {
    const tiers = [...$("setTiers").querySelectorAll("[data-tier]:checked")].map((x) => x.dataset.tier);
    await api("/api/settings", { tiers });
    await load();
  }));
  renderSettingsResult();
}
function renderSettingsResult() {
  const st = S.stats, w = st.work;
  $("setResult").innerHTML = `<b>≈ ${hrs(st.remainingSec)}</b> left → <b>${hrs(st.perDaySec)}/day</b> for ${st.daysLeft} days
    <div class="small muted">Videos ${hrs(w.video)} · New cards ${hrs(w.newCards)} · Reviews ${hrs(w.reviews)} · Bricks ${hrs(w.bricks)} · AMBOSS ${hrs(w.amboss)}</div>`;
}
async function savePin(f, value) {
  await api("/api/settings", { pins: { [f.key]: value } });
  await load();
  renderSettings();
}
async function setGoal(date) {
  if (!date) return;
  await api("/api/settings", { goalDate: { block: blockId, date } });
  await load();
  $("setGoal").value = S.block.goalDate;
  // the worker recounts already-scheduled reviews through the new date within a few seconds
  setTimeout(() => load().catch(() => {}), 7000);
}
function shiftGoal(days) {
  const d = new Date(S.block.goalDate + "T12:00");
  d.setDate(d.getDate() + days);
  setGoal(d.toISOString().slice(0, 10));
}
$("setGoal").onchange = (e) => setGoal(e.target.value);
$("goalMinus").onclick = () => shiftGoal(-1);
$("goalPlus").onclick = () => shiftGoal(1);
$("settingsBtn").onclick = (e) => { e.stopPropagation(); openSettings(); };

// ---------- commands (keyboard, shortcuts sheet, ⌘K palette) ----------
const isVideo = () => { const it = cur(); return !!it && it.type === "video" && view === "item"; };
const seek = (d) => (video.currentTime += d);
function stepRate(dir) {
  const i = RATES.indexOf(video.playbackRate);
  setRate(RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 0 : i) + dir))]);
}
const COMMANDS = [
  { group: "Video", title: "Play / pause", keys: ["Space", "K"], when: isVideo, run: togglePlay },
  { group: "Video", title: "Back 5 seconds", keys: ["←"], when: isVideo, run: () => seek(-5) },
  { group: "Video", title: "Forward 5 seconds", keys: ["→"], when: isVideo, run: () => seek(5) },
  { group: "Video", title: "Back 10 seconds", keys: ["J"], when: isVideo, run: () => seek(-10) },
  { group: "Video", title: "Forward 10 seconds", keys: ["L"], when: isVideo, run: () => seek(10) },
  { group: "Video", title: "Slower", keys: ["["], when: isVideo, run: () => stepRate(-1) },
  { group: "Video", title: "Faster", keys: ["]"], when: isVideo, run: () => stepRate(1) },
  { group: "Video", title: "Fullscreen", keys: ["F"], when: isVideo, run: toggleFullscreen },
  { group: "Video", title: "Mute / unmute", keys: ["M"], when: isVideo, run: () => (video.muted = !video.muted) },
  ...RATES.map((r) => ({ group: "Speed", title: `Speed ${r}×`, when: isVideo, run: () => setRate(r) })),
  ...DARK_MODES.map((m) => ({ group: "Picture", title: `Picture: ${m.label}`, when: isVideo, run: () => setDark(m.value) })),
  { group: "Items", title: "Next item", keys: ["N"], run: () => step(1) },
  { group: "Items", title: "Previous item", keys: ["P"], run: goPrev },
  { group: "Items", title: "Mark done", when: () => view === "item" && cur() && !cur().done, run: markDone },
  { group: "Items", title: "Mark not done", when: () => view === "item" && cur() && cur().done, run: () => $("undoneBtn").onclick() },
  { group: "Items", title: "Open brick in ScholarRx", when: () => view === "item" && cur() && cur().url, run: () => { window.open(cur().url, "_blank"); startTimer(); } },
  { group: "Items", title: "Edit timer", when: () => view === "item" && cur() && cur().type !== "video", run: editTimer },
  { group: "Items", title: "Reset timer to 0", when: () => view === "item" && cur() && cur().type !== "video", run: () => { timer.running = false; setTimerTo(0); } },
  { group: "Items", title: "Start / pause timer", keys: ["T"], when: () => view === "item" && cur() && cur().type !== "video", run: () => $("timerBtn").onclick() },
  { group: "Anki", title: "Open Anki", run: () => $("gateOpen").onclick() },
  { group: "Anki", title: "Skip the Anki gate", when: () => S && S.anki.gate, run: () => $("gateSkip").onclick() },
  ...Object.entries(TIER_LABELS).map(([t, label]) => ({
    group: "Anki", title: `Toggle tier: ${label}`,
    run: async () => {
      const cur = S.stats.cards.tiers;
      await api("/api/settings", { tiers: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
      await load();
    },
  })),
  { group: "Anki", title: "Today's Anki (reviews + new cards)", run: showAnki },
  { group: "Anki", title: "Rebuild VidAnki deck (pull in reviews due now)", run: async () => {
    try { const r = await api("/api/rebuild-deck", {}); toast(`VidAnki deck: ${r.cards} cards`); } catch (e) { toast(e.message, true); }
  } },
  { group: "Anki", title: "Refresh card counts", run: async () => { await api("/api/refresh-counts", { block: blockId }); await load(); toast("Card counts refreshed"); } },
  { group: "Items", title: "Hide / show done items", keys: ["H"], run: () => { $("hideDone").checked = !$("hideDone").checked; renderQueue(); } },
  { group: "App", title: "Settings: goal date & estimates", keys: [","], run: openSettings },
  { group: "App", title: "Goal date: one day later", run: () => shiftGoal(1) },
  { group: "App", title: "Goal date: one day earlier", run: () => shiftGoal(-1) },
  { group: "App", title: "Keyboard shortcuts", keys: ["?"], run: () => openModal("helpModal") },
  { group: "App", title: "Search commands", keys: ["⌘K"], run: () => openPalette() },
];
const KEYMAP = { " ": 0, k: 0, ArrowLeft: 1, ArrowRight: 2, j: 3, l: 4, "[": 5, "]": 6, f: 7, m: 8 };
COMMANDS.forEach((c, i) => {
  const extra = { n: "Next item", p: "Previous item", t: "Start / pause timer", h: "Hide / show done items", ",": "Settings: goal date & estimates", "?": "Keyboard shortcuts" };
  for (const [k, title] of Object.entries(extra)) if (c.title === title) KEYMAP[k] = i;
});

// shortcuts sheet
$("keysTable").innerHTML = (() => {
  let html = "", group = "";
  for (const c of COMMANDS.filter((c) => c.keys)) {
    if (c.group !== group) { group = c.group; html += `<tr><th colspan="2">${group}</th></tr>`; }
    html += `<tr><td>${c.title}</td><td>${c.keys.map((k) => `<kbd>${k}</kbd>`).join("")}</td></tr>`;
  }
  return html;
})();
function openModal(id) { closeModals(); $(id).hidden = false; }
function closeModals() { document.querySelectorAll(".modal").forEach((m) => (m.hidden = true)); }
$("helpBtn").onclick = (e) => { e.stopPropagation(); openModal("helpModal"); };
document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => {
  if (e.target === m || e.target.closest("[data-close]")) closeModals();
}));

// ⌘K palette
let palItems = [], palIdx = 0;
function openPalette() {
  openModal("palette");
  $("palInput").value = "";
  renderPalette();
  $("palInput").focus();
}
function fuzzy(q, text) {
  // subsequence match; consecutive and word-start hits score higher
  q = q.toLowerCase(); text = text.toLowerCase();
  let ti = 0, score = 0, prev = -2;
  for (const ch of q) {
    const i = text.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === prev + 1 ? 3 : (i === 0 || " :-/(".includes(text[i - 1]) ? 2 : 1);
    prev = i; ti = i + 1;
  }
  return score - text.length * 0.01;
}
function palSource() {
  const cmds = COMMANDS.filter((c) => !c.when || c.when())
    .map((c) => ({ group: c.group, title: c.title, hint: c.keys ? c.keys.join(" / ") : "", run: c.run }));
  const items = flat.map((i) => ({
    group: i.done ? "Done" : "Go to", title: i.title, hint: i.cluster,
    run: () => { view = "item"; showItem(i.id); renderQueue(); },
  }));
  const blocks = (S ? S.blocks : []).filter((b) => b.id !== blockId)
    .map((b) => ({ group: "Block", title: `Switch to ${b.name}`, hint: "", run: () => switchBlock(b.id) }));
  return [...cmds, ...blocks, ...items];
}
function renderPalette() {
  const q = $("palInput").value.trim();
  const src = palSource();
  palItems = q ? src.map((x) => ({ x, s: fuzzy(q, x.group + " " + x.title) }))
    .filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).map((r) => r.x) : src;
  palItems = palItems.slice(0, 60);
  palIdx = 0;
  drawPalette();
}
function drawPalette() {
  $("palList").innerHTML = palItems.length ? palItems.map((p, i) =>
    `<div class="pal-item ${i === palIdx ? "active" : ""}" data-i="${i}"><span><span class="pg">${p.group}</span>${p.title}</span><span class="pk">${p.hint}</span></div>`
  ).join("") : `<div class="pal-empty">No matches</div>`;
  $("palList").querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
function runPal(i) {
  const p = palItems[i];
  closeModals();
  if (p) p.run();
}
$("palInput").addEventListener("input", renderPalette);
$("palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    palIdx = (palIdx + (e.key === "ArrowDown" ? 1 : -1) + palItems.length) % Math.max(palItems.length, 1);
    drawPalette();
  } else if (e.key === "Enter") runPal(palIdx);
  else if (e.key === "Escape") closeModals();
  else return;
  e.preventDefault();
});
$("palList").addEventListener("click", (e) => {
  const el = e.target.closest(".pal-item");
  if (el) runPal(+el.dataset.i);
});
$("paletteBtn").onclick = (e) => { e.stopPropagation(); openPalette(); };

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("palette").hidden ? openPalette() : closeModals();
    return;
  }
  if (e.key === "Escape" && document.querySelector(".modal:not([hidden])")) { closeModals(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target instanceof Element ? e.target : document.body;
  if (t.closest("input:not([type=range]), textarea, .dd.open, .modal")) return;
  const idx = KEYMAP[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? KEYMAP[e.key];
  if (idx === undefined) return;
  const c = COMMANDS[idx];
  if (c.when && !c.when()) return;
  e.preventDefault(); // also stops space from "clicking" whatever button has focus
  if (t.closest("button, .dd, input")) t.blur();
  c.run();
});

// ---------- polling ----------
setInterval(() => {
  // keep stats fresh; poll faster while waiting on Anki
  if (view === "gate" || Date.now() - (window._lastPoll || 0) > 30000) {
    window._lastPoll = Date.now();
    load().catch(() => {});
  }
}, 8000);

load().catch((e) => { $("itemTitle").textContent = "Server error: " + e.message; });
