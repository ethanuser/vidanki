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
// All durations show as hours with one decimal.
const hrs = (s) => (s > 0 && s < 180 ? "<0.1" : (s / 3600).toFixed(1)) + " h";
function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}
const estTotal = (it) => { const e = it.est || {}; return (e.video || 0) + (e.anki || 0) + (e.other || 0); };
const cur = () => flat.find((i) => i.id === curId);
const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  if (err) Sound.play("error");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    t.classList.add("out");
    toast.t = setTimeout(() => (t.hidden = true), 120);
  }, err ? 9000 : 5000);
}
// Replay a one-shot CSS animation. dir is the direction of travel, for nudge/rubber/enter.
function cue(el, cls, dir = 1) {
  if (!el) return;
  el.style.setProperty("--dir", dir);
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el["cue" + cls]);
  el["cue" + cls] = setTimeout(() => el.classList.remove(cls), 500);
}
// Hit the end of something: it pushes back with a soft tap.
function limit(el, dir = 1) { cue(el, "nudge", dir); Sound.play("limit"); }
const wait = (ms) => new Promise((r) => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms));
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
  dot.dataset.tip = S.anki.ok ? "Anki connected" : "Anki closed";
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
  return `<div class="stat" data-k="${k}" data-tip="${attr(title)}"><span class="k">${k}</span><span class="v ${cls}">${v}</span>` +
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
  const html = [
    group("",
      stat("Done", `${st.items.done} / ${st.items.count}`, "", st.items.done / st.items.count,
        `${st.items.videosDone}/${st.items.videos} videos`),
      stat("Hours", `${hrs(hoursDone())} / ${hrs(hoursDone() + st.remainingSec)}`, "",
        hoursDone() / (hoursDone() + st.remainingSec), "Items + Anki")),
    group("goal clickable",
      stat("Goal", `${goalStr}, ${st.daysLeft} d`),
      stat("Work left", "≈ " + hrs(st.remainingSec), "", null,
        workParts(w).map((p) => `${p.label}\t${hrs(p.sec)}`).join("\n")),
      stat("Needed", `${hrs(st.perDaySec)}/day`)),
    group("",
      stat("Today", `${hrs(st.todaySec)} / ${hrs(st.todayNeededSec)}`, "", st.todaySec / st.todayNeededSec),
      stat("Pace", pace, paceCls, null, "Last 3 study days → finish")),
  ].join("");
  if (html === renderStats.html) { if (!$("settingsModal").hidden) renderSettingsResult(); return; }  // a poll with no news leaves the header alone
  renderStats.html = html;
  $("stats").innerHTML = html;
  animateStats();
  const goalGroup = $("stats").querySelector(".goal");
  goalGroup.dataset.tip = "Edit goal (,)";
  goalGroup.onclick = openSettings;
  if (!$("settingsModal").hidden) renderSettingsResult();
}

const workParts = (w) => [
  { label: "Videos", sec: w.video, cls: "video" }, { label: "New cards", sec: w.newCards, cls: "new" },
  { label: "Reviews", sec: w.reviews, cls: "rev" }, { label: "Bricks", sec: w.bricks, cls: "brick" },
  { label: "AMBOSS", sec: w.amboss, cls: "amboss" },
];
// The header is rebuilt on every poll: slide bars from where they were, bump numbers that moved.
const lastStats = {};
function animateStats() {
  $("stats").querySelectorAll(".stat").forEach((el) => {
    const was = lastStats[el.dataset.k], fill = el.querySelector(".bar > div"), v = el.querySelector(".v");
    const now = { width: fill && fill.style.width, text: v.textContent };
    lastStats[el.dataset.k] = now;
    if (!was) return;
    if (fill && was.width !== now.width) { fill.style.width = was.width; void fill.offsetWidth; fill.style.width = now.width; }
    if (was.text !== now.text && (el.dataset.k === "Done" || el.dataset.k === "Today")) cue(v, "bump");
  });
}

function todaySet() {
  // Pending items that fit in what's left of today's target, in order.
  const left = S.stats.todayNeededSec - S.stats.todaySec;
  const out = new Set();
  // today's share of reviews comes first, then open-batch new cards, then items in order
  let acc = S.stats.todayAnkiSec;
  for (const it of flat) {
    if (it.done || !inPlan(it)) continue;  // collapsed "If time" isn't part of today's target
    if (acc >= left) break;
    out.add(it.id);
    acc += estTotal(it);
  }
  return out;
}

// Item counted in the plan: core items, plus "If time" when that section is open.
const inPlan = (i) => !i.optional || S.stats.includeOptional;
// Hours done: time the finished items took plus all Anki time logged.
function hoursDone() {
  const items = flat.filter((i) => i.done && inPlan(i)).reduce((a, i) => a + timeTaken(i), 0);
  const anki = Object.values(S.stats.days || {}).reduce((a, d) => a + (d.anki || 0), 0);
  return items + anki;
}
// study-day date (days roll over at 4 am, like Anki)
const shortDate = (ts) => new Date((ts - 4 * 3600) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

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
  const pendingPlan = flat.filter((i) => !i.done && inPlan(i)).length;
  const lastToday = today.size < pendingPlan ? [...today].at(-1) : undefined;
  const leftToday = Math.max(S.stats.todayNeededSec - S.stats.todaySec, 0);
  // The line where today's target runs out. Everything below it can wait.
  const todayLine = () => `<div class="today-line"><span>${leftToday ? "End of today" : "Today's target reached"}</span>${leftToday ? `<span>${hrs(leftToday)} left</span>` : ""}</div>`;
  let html = "", beyond = false, group = null;
  const a = S.stats.ankiNow;
  // Anki row: only when there's a real chunk of cards (or a video is waiting on them)
  if (ankiRowShown()) {
    // same order and wording as Anki's deck list: new, learning, review
    const parts = [a.new && `${a.new} new`, a.learn && `${a.learn} learning`, a.review && `${a.review} review`].filter(Boolean);
    html += `<div class="cluster"><div class="cluster-title lead"><span>Anki</span><span>${hrs(a.sec)}</span></div>
      <div class="qi ${view === "anki" ? "current" : ""}" data-id="__anki">
        <span class="chk"></span><span class="qt"><span class="tag anki">ANKI</span>${parts.join(", ") || "Cards waiting"}</span>
        <span class="qm">${hrs(a.sec)}</span></div></div>`;
  }
  if (!today.size && pendingPlan) { html += todayLine(); beyond = true; }
  const left = (items) => items.filter((i) => !i.done).reduce((t, i) => t + estTotal(i), 0);
  const taken = (items) => items.filter((i) => i.done).reduce((t, i) => t + timeTaken(i), 0);
  // right side of a section title: time left, or with done items showing, progress
  const sectionMeta = (items) => {
    const l = left(items), n = items.filter((i) => i.done).length;
    if (n === items.length) return `${icon("check")}${hide ? "" : hrs(taken(items))}`;
    if (hide) return hrs(l);
    const t = taken(items);
    return `<span class="count">${n}/${items.length}</span>${n ? `${hrs(t)} / ${hrs(t + l)}` : hrs(l)}`;
  };
  for (const c of S.clusters) {
    const items = c.items.filter((i) => !hide || !i.done || i.id === curId);
    if (!items.length) continue;
    if (c.group && c.group !== group) {  // heading over the topic sections of a phase
      group = c.group;
      const all = S.clusters.filter((x) => x.group === group).flatMap((x) => x.items);
      html += `<div class="group-title"><span>${group}</span><span class="meta">${sectionMeta(all)}</span></div>`;
    }
    const meta = sectionMeta(c.items);
    const opt = c.items.some((i) => i.optional);
    if (opt) {  // "If time": a dropdown; open = shown and counted in the totals, closed = "+" what it would add
      const open = S.stats.includeOptional;
      html += `<div class="cluster optional"><button class="cluster-title lead opt-toggle" data-toggle-optional aria-expanded="${open}">
        <span><span class="caret"></span>${c.title} (${c.items.length})</span><span class="meta">${open ? meta : "+" + hrs(left(c.items))}</span></button>`;
      if (!open) { html += "</div>"; continue; }
    } else {
      html += `<div class="cluster"><div class="cluster-title ${c.group ? "" : "lead"}"><span data-clip data-tip="${attr(c.title)}">${c.title}</span><span class="meta">${meta}</span></div>`;
    }
    for (const i of items) {
      const tag = i.type === "video" ? (i.source === "bnb" ? "B&B" : "SK") : i.type === "brick" ? "BRX" : "AMB";
      const cls = i.type === "video" ? i.source : i.type;
      let m = hrs(i.done ? timeTaken(i) : estTotal(i));
      if (i.done && !hide && i.doneAt) m = `<span class="date">${shortDate(i.doneAt)}</span>${m}`;
      const name = i.title.replace(/^Sketchy (Micro|Pharm): /, "");
      if (i.type === "video" && i.est && i.missing) m = "missing";
      html += `<div class="qi ${i.done ? "done" : ""} ${i.id === curId && view !== "anki" ? "current" : ""} ${beyond && !i.done ? "later" : ""}" data-id="${i.id}">
        <span class="chk">${i.done ? icon("check") : ""}</span>
        <span class="qt" data-clip data-tip="${attr(name)}"><span class="tag ${cls}">${tag}</span>${name}</span>
        <span class="qm">${m}</span></div>`;
      if (i.id === lastToday) { html += todayLine(); beyond = true; }
    }
    html += "</div>";
  }
  if (html !== renderQueue.html) $("queueList").innerHTML = renderQueue.html = html;
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
    `<tr data-tip="${attr(tip)}"><td>${k}</td><td>${amount}</td><td>${rate}</td><td>${hrs(sec)}</td></tr>`;
  $("estBody").innerHTML = `<table class="est-table">
    <thead><tr><th></th><th>Left</th><th>Each</th><th>Time</th></tr></thead>
    <tbody>
    ${row("Videos", hrs(vidLeft), `${r.videoFactor.bnb.toFixed(1)}× / ${r.videoFactor.sketchy.toFixed(1)}×`, w.video, "B&B / Sketchy")}
    ${row("New cards", c.newLeft, `${Math.round(r.cardSec)} s`, w.newCards, c.waitingNew ? `${c.waitingNew} already unsuspended` : "")}
    ${row("Reviews", c.existingReviews + Math.round(c.freshReviews), `${r.reviewSec} s`, w.reviews, `${c.existingReviews} due + ~${Math.round(c.freshReviews)} from new cards`)}
    ${row("Bricks", bricks, hrs(r.brickSec), w.bricks)}
    ${row("AMBOSS", `${aq} Q`, `${(r.ambossSecPerQ / 60).toFixed(1)} min`, w.amboss)}
    </tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td>${hrs(total)}</td></tr></tfoot>
  </table>
  <div class="est-sub">Unsuspend</div>
  <div class="tiers">
    ${Object.entries(TIER_LABELS).map(([t, label]) =>
      `<label class="check"><input type="checkbox" data-tier="${t}" ${c.tiers.includes(t) ? "checked" : ""}><span></span>${label}</label>`).join("")}
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
    const atStart = view !== "gate" && at <= 0, atEnd = view !== "gate" && (at < 0 || at >= order.length - 1);
    $("prevBtn").setAttribute("aria-disabled", atStart);
    $("nextBtn").setAttribute("aria-disabled", atEnd);
    $("prevBtn").dataset.tip = atStart ? "Start of queue" : "Previous item (P)";
    $("nextBtn").dataset.tip = atEnd ? "End of queue" : "Next item (N)";
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
  $("crumbs").textContent = `${S.block.name} / ${it.topic || it.cluster}`;
  $("itemTitle").textContent = it.title;
  $("itemTitle").dataset.tip = it.title;
  $("itemNote").hidden = !it.note;
  $("itemNote").textContent = it.note || "";
  $("doneBtn").hidden = it.done;
  $("undoneBtn").hidden = !it.done;
  const cards = !it.optional && it.type === "video" && it.est && it.est.cards;
  $("doneBtn").innerHTML = icon("check") + "Mark done" + (cards ? `<span class="btn-badge">+${cards} cards</span>` : "");
  $("doneBtn").dataset.tip = it.optional ? "No cards" : "";
  const isVideo = it.type === "video";
  $("player").hidden = !isVideo;
  $("task").hidden = isVideo;
  if (isVideo) setupVideo(it);
  else { pauseVideo(); setupTask(it); leaveFullscreen(); }
  document.querySelectorAll(".qi").forEach((el) => el.classList.toggle("current", el.dataset.id === curId));
  syncQueue();
}
function setupTask(it) {
  const amb = it.type === "amboss";
  $("ambossFields").hidden = !amb;
  $("taskLink").hidden = !amb && !it.url;
  $("taskLink").href = amb ? "https://next.amboss.com/us/learning" : it.url || "";
  $("taskLinkText").textContent = amb ? "Open AMBOSS" : "Open brick";
  $("taskKind").textContent = amb ? `AMBOSS, ${it.questions} Q` : "ScholarRx brick, end questions";
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
const DARK_MODES = [
  { value: "auto", label: "Match app", short: "Auto" },
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
    freezeFrame();
    const resume = it.pos > 5 && !(it.duration && it.pos >= it.duration - 20);
    const l = loading = { it, resume };
    clearTimeout(revealT);
    revealT = setTimeout(() => l === loading && reveal(), 2000);
    video.src = `/media/${encodeURIComponent(blockId)}/${encodeURIComponent(it.id)}`;
    showTime(resume ? it.pos : 0, it.duration || 0);
  }
  rateDD.setValue(S.settings.rate || 1);
  darkDD.setValue(darkSetting(it));
  if (!loading) applyDark(darkSetting(it));
}

// Changing a video's source blanks it, so the last picture stays up, as a copy,
// until the new video has a frame at the right spot. Then they swap in one paint.
let loading = null, revealT = 0;
function freezeFrame() {
  const fz = $("freeze"), gl = $("glcanvas");
  if (!fz.hidden || video.readyState < 2) return;
  const shaded = renderer && !gl.hidden;
  if (shaded) renderer.drawNow();  // WebGL's buffer is only readable right after a draw
  fz.width = shaded ? gl.width : video.videoWidth;
  fz.height = shaded ? gl.height : video.videoHeight;
  fz.getContext("2d").drawImage(shaded ? gl : video, 0, 0, fz.width, fz.height);
  fz.style.filter = video.style.filter;
  fz.hidden = false;
}
function frameReady() {
  const l = loading;
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => l === loading && reveal());
  setTimeout(() => l === loading && reveal(), 120);  // the frame may already be up, or the tab hidden
}
function reveal() {
  const { it } = loading;
  loading = null;
  clearTimeout(revealT);
  applyDark(darkSetting(it));
  if (renderer && !$("glcanvas").hidden) renderer.settle();
  $("freeze").hidden = true;
  if (video.duration) showTime(video.currentTime, video.duration);
}
video.addEventListener("loadedmetadata", () => {
  video.playbackRate = S.settings.rate || 1;
  if (!loading) return;
  if (loading.resume && loading.it.pos < video.duration - 20) video.currentTime = loading.it.pos;
  else loading.resume = false;
});
video.addEventListener("loadeddata", () => { if (loading && !loading.resume) frameReady(); });
video.addEventListener("seeked", () => { if (loading) frameReady(); });
video.addEventListener("error", () => { if (loading) reveal(); });

function setDark(mode) {
  const it = cur();
  if (!it || it.type !== "video") return;
  S.settings.dark = { ...(S.settings.dark || {}), [it.source]: mode };
  darkDD.setValue(mode);
  applyDark(mode);
  api("/api/settings", { dark: S.settings.dark });
}

function applyDark(mode) {
  if (mode === "auto") mode = Theme.dark ? "smart" : "off";
  const canvas = $("glcanvas");
  if (mode === "smart" && !renderer) {
    try { renderer = SmartDark.create(canvas, video); } catch (e) { console.error(e); }
    if (!renderer) mode = "invert";
  }
  // Smart dark and Invert both go through the shader, which keeps the video's
  // own black bars black; the CSS filter is only a fallback without WebGL.
  if (mode === "invert" && !renderer) {
    try { renderer = SmartDark.create(canvas, video); } catch (e) { console.error(e); }
  }
  const shaded = renderer && (mode === "smart" || mode === "invert");
  canvas.hidden = !shaded;
  if (shaded) { renderer.setPlain(mode === "invert"); renderer.setTint(Theme.hue); renderer.start(); renderer.drawNow(); } else if (renderer) renderer.stop();
  video.style.filter = shaded ? "" : ({ invert: "invert(1) hue-rotate(180deg)", dim: "brightness(.78) contrast(1.05)" }[mode] || "");
}
Theme.onChange(() => {
  const it = cur();
  if (it && it.type === "video") applyDark(darkSetting(it));
});

function pauseVideo() { if (!video.paused) video.pause(); }
function togglePlay() {
  flashPic(icon(video.paused ? "play" : "pause"));
  if (video.paused) video.play(); else video.pause();
}
function flashPic(html, side = "") {
  const f = $("picFlash");
  f.innerHTML = html;
  f.className = "pic-flash " + side;
  void f.offsetWidth;
  f.classList.add("show");
}
function setRate(r) {
  video.playbackRate = r;
  rateDD.setValue(r);
  S.settings.rate = r;
  api("/api/settings", { rate: r });
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen(); else $("stage").requestFullscreen();
}
function leaveFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); }  // only the player can be fullscreen

$("playBtn").onclick = togglePlay;
$("back10").onclick = () => seek(-10);
$("fwd10").onclick = () => seek(10);
$("vol").oninput = (e) => {
  video.volume = +e.target.value;
  video.muted = false;
  try { localStorage.setItem("vidanki.volume", video.volume); } catch {}
};
try {
  const v = parseFloat(localStorage.getItem("vidanki.volume"));
  if (v >= 0 && v <= 1) { video.volume = v; $("vol").value = v; }
} catch {}
$("fsBtn").onclick = toggleFullscreen;
$("seek").oninput = (e) => { if (video.duration) video.currentTime = (e.target.value / 1000) * video.duration; };
$("picture").addEventListener("click", (e) => { if (!e.target.closest("#endCard")) togglePlay(); });
$("playBtn").innerHTML = icon("play");
video.addEventListener("play", () => ($("playBtn").innerHTML = icon("pause")));
video.addEventListener("pause", () => ($("playBtn").innerHTML = icon("play")));
function showTime(t, d) {
  $("time").textContent = `${clock(t)} / ${clock(d)}` +
    (video.playbackRate !== 1 ? `, ${clock((d - t) / video.playbackRate)} left` : "");
  if (document.activeElement !== $("seek")) $("seek").value = d ? (t / d) * 1000 : 0;
  $("seek").style.setProperty("--p", (d ? (t / d) * 100 : 0) + "%");
}
video.addEventListener("timeupdate", () => {
  if (loading) return;  // the old position, or frame 0 before the resume seek lands
  const d = video.duration || 0;
  showTime(video.currentTime, d);
  if (d && !endShown && video.currentTime >= d - 12) showEndCard();
});
video.addEventListener("ended", showEndCard);

function showEndCard() {
  if (endShown) return;
  endShown = true;
  const it = cur();
  if (!it || it.done) return;
  const n = it.est && it.est.cards;
  $("endCardSub").textContent = n ? `+${n} cards` : "";
  $("endCard").hidden = false;
  $("stage").classList.remove("idle");
}
$("endDone").onclick = () => { $("endCard").hidden = true; markDone(); };
$("endKeep").onclick = () => { $("endCard").hidden = true; Sound.play("close"); };

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
  $("timerVal").classList.toggle("running", timer.running);
  // symbol button, fixed width; the tooltip says what it does
  $("timerBtn").innerHTML = icon(timer.running ? "pause" : "play");
  $("timerBtn").dataset.tip = (timer.running ? "Pause timer" : timer.shown ? "Resume timer" : "Start timer") + " (T)";
  $("timerBtn").className = timer.running ? "t-pause" : "t-start";
}
$("timerBtn").onclick = () => { timer.running = !timer.running; Sound.play(timer.running ? "start" : "pause"); updateTimer(); };
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
    if (sec === null) { limit(e.target); return; }
    closeTimerEdit();
    setTimerTo(sec);
    Sound.play("confirm");
  } else if (e.key === "Escape") { e.stopPropagation(); closeTimerEdit(); Sound.play("close"); }
});
$("timerEdit").addEventListener("blur", closeTimerEdit);
let resetArmed = null;
$("timerReset").onclick = () => {
  const btn = $("timerReset");
  if (!resetArmed) {  // two clicks, so a stray one doesn't wipe the time
    btn.textContent = "Confirm reset";
    btn.classList.add("confirm");
    resetArmed = setTimeout(() => { resetArmed = null; btn.innerHTML = icon("reset"); btn.classList.remove("confirm"); }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  btn.innerHTML = icon("reset");
  btn.classList.remove("confirm");
  timer.running = false;
  setTimerTo(0);
  Sound.play("confirm");
};

// Opening the brick or AMBOSS starts the timer (it keeps running while you're in that tab).
function startTimer() { if (!timer.running) { timer.running = true; Sound.play("start"); updateTimer(); } }
$("taskLink").addEventListener("click", startTimer);

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
    const section = S.clusters.find((c) => c.items.some((i) => i.id === it.id));
    const lastInSection = section && section.items.every((i) => i.done || i.id === it.id);
    Sound.play(lastInSection ? "milestone" : "done");
    if (r.batch) toast(r.batch.needsAnki ? "Cards unsuspend when Anki opens" : `+${r.batch.newCards} new cards in ${S.anki.deck}`);
    await tickRow(it.id);
    await load();
    if (S.anki.gate) { gateFor = S.anki.gate.title; view = "gate"; renderGate(); }
    else goNext();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $("doneBtn").disabled = false;
  }
}

// The queue row ticks its box, then folds away if done items are hidden.
async function tickRow(id) {
  const row = document.querySelector(`.qi[data-id="${id}"]`);
  if (!row) return;
  row.querySelector(".chk").innerHTML = icon("check");
  row.classList.add("ticking");
  await wait(280);
  if (!$("hideDone").checked) return;
  row.style.height = row.offsetHeight + "px";
  void row.offsetWidth;
  row.classList.add("leaving");
  row.style.height = "0";
  await wait(200);
}

function goNext() {
  const n = nextPending(curId);
  if (!n) { toast("Block done"); Sound.play("milestone"); return; }
  if (S.anki.gate && n.type === "video") { gateFor = S.anki.gate.title; view = "gate"; renderGate(); return; }
  showItem(n.id);
  renderQueue();
}

function renderGate() {
  flushTime();
  pauseVideo();
  leaveFullscreen();
  $("ankiPanel").hidden = true;
  $("player").hidden = true;
  $("task").hidden = true;
  $("gate").hidden = false;
  $("doneBtn").hidden = true;
  $("undoneBtn").hidden = true;
  $("itemNote").hidden = true;
  $("crumbs").textContent = S.block.name;
  $("itemTitle").textContent = "Anki first";
  const g = S.anki.gate, next = nextPending(curId);
  const nextTitle = next ? next.title : "Next";
  const from = g && `${g.title}${g.others ? ` +${g.others}` : ""} → ${nextTitle}`;
  $("gateWarn").hidden = !(g && g.deckError);
  if (g && g.deckError) $("gateWarn").textContent = "Deck not built. Restart Anki";
  if (!g) {  // cleared
    if (gateFor && renderGate.cleared !== gateFor) { renderGate.cleared = gateFor; Sound.play("milestone"); }
    $("itemTitle").textContent = "Anki done";
    if (!$("gateNum").classList.contains("good")) $("gateNum").innerHTML = icon("check");  // draws once, not on every poll
    $("gateNum").className = "hero-num good";
    $("gateText").textContent = "All done";
    $("gateFrom").textContent = gateFor || "";
    $("gateProgress").hidden = true;
    $("gateOpen").hidden = true;
    $("gateSkip").hidden = true;
    $("gateNext").hidden = !next;
    $("gateNext").innerHTML = `${next ? attr(next.title) : ""}${icon("chevron-right")}`;
    return;
  }
  $("gateOpen").hidden = false;
  $("gateSkip").hidden = false;
  $("gateNext").hidden = true;
  $("gateNum").className = "hero-num";
  if (g.needsAnki) {
    $("gateNum").textContent = "";
    $("gateText").textContent = "Open Anki to unsuspend";
    $("gateFrom").textContent = from;
    $("gateProgress").hidden = true;
    return;
  }
  const left = g.newLeft + g.newLater, done = Math.max(g.total - left, 0);
  const moved = $("gateNum").textContent !== String(g.newLeft) && $("gateNum").textContent !== "";
  $("gateNum").textContent = g.newLeft;
  if (moved) cue($("gateNum"), "bump");
  $("gateText").textContent = `new card${g.newLeft === 1 ? "" : "s"}`;
  $("gateFrom").textContent = from;
  $("gateProgress").hidden = false;
  $("gateBar").style.width = (g.total ? (done / g.total) * 100 : 100) + "%";
  $("gateDone").textContent = `${done} / ${g.total}`;
  $("gateLater").textContent = g.newLater ? `+${g.newLater} tomorrow` : "";
}

function showAnki() {
  flushTime();
  view = "anki";
  renderAnkiPanel();
  renderQueue();
}
function renderAnkiPanel() {
  pauseVideo();
  leaveFullscreen();
  ["player", "task", "gate"].forEach((id) => ($(id).hidden = true));
  $("ankiPanel").hidden = false;
  $("doneBtn").hidden = true;
  $("undoneBtn").hidden = true;
  $("itemNote").hidden = true;
  $("crumbs").textContent = `${S.block.name} / Anki`;
  const a = S.stats.ankiNow, r = S.stats.rates, g = S.anki.gate;
  // same three counts and colors as Anki's deck list
  const tile = (k, n, sec, cls) => `<div class="tile ${cls}"><div class="tile-num">${n}</div><div class="tile-k">${k}</div><div class="tile-t">${hrs(sec)}</div></div>`;
  $("ankiTiles").innerHTML = tile("New", a.new, a.new * r.cardSec, "new") +
    tile("Learning", a.learn, a.learn * r.reviewSec, "learn") + tile("Review", a.review, a.review * r.reviewSec, "rev");
  $("itemTitle").innerHTML = `Today's Anki <span class="title-meta">${hrs(a.sec)}</span>`;
  const next = nextPending(curId);
  const notes = [
    g && !g.needsAnki && next ? `<b>${g.newLeft}</b> new → <b>${next.title}</b>` : "",
    a.newLater ? `+${a.newLater} new tomorrow` : "",
  ].filter(Boolean);
  $("ankiSub").hidden = !notes.length;
  $("ankiSub").innerHTML = notes.map((t) => `<p>${t}</p>`).join("");
}
// The button says it worked, since Anki itself opens out of sight.
async function openAnki(btn) {
  try {
    await api("/api/open-anki", {});
    Sound.play("select");
    const label = btn.innerHTML;
    btn.innerHTML = icon("check") + "Opened";
    setTimeout(() => (btn.innerHTML = label), 1400);
  } catch (e) { toast(e.message, true); }
}
$("ankiOpen").onclick = () => openAnki($("ankiOpen"));
$("ankiRebuild").onclick = async () => {
  const btn = $("ankiRebuild");
  btn.classList.add("spin");
  btn.disabled = true;
  try { const r = await api("/api/rebuild-deck", {}); toast(`Deck rebuilt, ${r.cards} cards`); Sound.play("confirm"); await load(); }
  catch (e) { toast(e.message, true); }
  btn.classList.remove("spin");
  btn.disabled = false;
};
$("gateOpen").onclick = () => openAnki($("gateOpen"));
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
    toast("Marked not done");
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
  const ids = flat.filter((i) => (!hide || !i.done || i.id === curId) && (inPlan(i) || i.id === curId)).map((i) => i.id);
  return ankiRowShown() ? ["__anki", ...ids] : ids;
}
function step(dir) {
  if (view === "gate") {  // the gate is soft: Next moves on anyway, Prev goes back
    Sound.play("select");
    if (dir > 0) (S.anki.gate ? $("gateSkip") : $("gateNext")).onclick();
    else { view = "item"; showItem(curId); renderQueue(); }
    return;
  }
  const order = queueOrder();
  const at = order.indexOf(view === "anki" ? "__anki" : curId);
  const id = order[at + dir];
  if (id === undefined) {  // the end of the queue pushes back
    limit($(dir > 0 ? "nextBtn" : "prevBtn"), dir);
    cue($("queueList"), "rubber", dir);
    return;
  }
  Sound.play("select");
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
$("queueList").addEventListener("click", async (e) => {
  if (!e.target.closest("[data-toggle-optional]")) return;
  e.stopImmediatePropagation();
  Sound.play("toggle");
  await api("/api/settings", { includeOptional: !S.stats.includeOptional });
  await load();
}, true);
$("queueList").onclick = (e) => {
  const el = e.target.closest(".qi");
  if (!el) return;
  Sound.play("select");
  if (el.dataset.id === "__anki") { showAnki(); return; }
  view = "item";
  showItem(el.dataset.id);
  renderQueue();
};
$("hideDone").onchange = () => { Sound.play("toggle"); renderQueue(); };
$("estDetails").addEventListener("toggle", (e) => Sound.play(e.target.open ? "open" : "close"));
// keep the player from outgrowing the window, whatever height the header wraps to
new ResizeObserver(([e]) => document.documentElement.style.setProperty("--head-h", e.target.offsetHeight + "px")).observe($("top"));

// ---------- settings ----------
const PIN_FIELDS = [
  { key: "bnbFactor", label: "B&B video", unit: "× length", get: (r) => r.videoFactor.bnb, scale: 1, dp: 2 },
  { key: "sketchyFactor", label: "Sketchy video", unit: "× length", get: (r) => r.videoFactor.sketchy, scale: 1, dp: 2 },
  { key: "cardSec", label: "New card", unit: "s", get: (r) => r.cardSec, scale: 1, dp: 0 },
  { key: "reviewSec", label: "Review", unit: "s", get: (r) => r.reviewSec, scale: 1, dp: 0 },
  { key: "brickSec", label: "Brick", unit: "min", get: (r) => r.brickSec, scale: 60, dp: 1 },
  { key: "ambossSecPerQ", label: "AMBOSS question", unit: "min", get: (r) => r.ambossSecPerQ, scale: 60, dp: 1 },
];
function openSettings() {
  openModal("settingsModal");
  renderSettings();
  $("soundOn").checked = Sound.on;
  $("soundVol").value = Sound.volume;
  renderLook();
}
$("soundOn").onchange = (e) => { Sound.on = e.target.checked; Sound.play("toggle"); };
$("soundVol").oninput = (e) => { Sound.volume = +e.target.value; };
$("soundVol").onchange = () => Sound.play("done");  // preview at the new volume
function setLook(key, value) {
  Theme.fade();
  Theme[key] = value;
  Sound.play("toggle");
  renderLook();
}
const modePick = new Segmented($("modePick"), { options: Theme.MODES, value: Theme.mode, onChange: (v) => setLook("mode", v) });
const fontPick = new Segmented($("fontPick"), { options: Theme.FONTS, value: Theme.font, onChange: (v) => setLook("font", v) });
$("themePick").innerHTML = Theme.THEMES.map((t) => `<button type="button" class="swatch" role="radio" data-hue="${t.hue}" style="--sw:${t.hue}"><span class="sw-chip"></span>${t.name}</button>`).join("");
$("themePick").onclick = (e) => {
  const b = e.target.closest(".swatch");
  if (b) setLook("hue", +b.dataset.hue);
};
$("hueSlider").oninput = (e) => { Theme.hue = +e.target.value; renderLook(); };
function renderLook() {
  $("hueSlider").value = Theme.hue;
  document.querySelectorAll(".swatch").forEach((b) => b.setAttribute("aria-checked", +b.dataset.hue === Theme.hue));
  modePick.setValue(Theme.mode);
  fontPick.setValue(Theme.font);
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
      <button class="icon-btn reset" aria-label="Use learned value" data-tip="Use learned value">${icon("reset")}</button></div>`;
  }).join("");
  $("setPins").querySelectorAll(".set-row").forEach((row) => {
    const f = PIN_FIELDS.find((x) => x.key === row.dataset.key);
    const input = row.querySelector("input");
    input.onchange = () => savePin(f, input.value === "" ? null : parseFloat(input.value) * f.scale);
    row.querySelector(".reset").onclick = () => savePin(f, null);
  });
  $("setTiers").innerHTML = Object.entries(TIER_LABELS).map(([t, label]) =>
    `<label class="check"><input type="checkbox" data-tier="${t}" ${S.stats.cards.tiers.includes(t) ? "checked" : ""}><span></span>${label}</label>`).join("");
  const rev = S.settings.reviewsInDeck !== false;
  $("setDeck").innerHTML = (
    `<label class="check"><input type="checkbox" id="setReviewsInDeck" ${rev ? "checked" : ""}><span></span>Study everything from the VidAnki deck</label>`);
  $("setReviewsInDeck").onchange = async (e) => {
    await api("/api/settings", { reviewsInDeck: e.target.checked });
    await api("/api/rebuild-deck", {}).catch((err) => toast(err.message, true));
    await load();
    toast(e.target.checked ? "Reviews in VidAnki deck" : "Reviews in AnKing deck");
  };
  $("setTiers").querySelectorAll("[data-tier]").forEach((el) => (el.onchange = async () => {
    const tiers = [...$("setTiers").querySelectorAll("[data-tier]:checked")].map((x) => x.dataset.tier);
    await api("/api/settings", { tiers });
    await load();
  }));
  renderSettingsResult();
}
function renderSettingsResult() {
  const st = S.stats, parts = workParts(st.work).filter((p) => p.sec > 0);
  $("setResult").innerHTML = `<b>≈ ${hrs(st.remainingSec)}</b> left → <b>${hrs(st.perDaySec)}/day</b> for ${st.daysLeft} days
    <div class="mix">${parts.map((p) => `<i class="c-${p.cls}" style="flex:${p.sec}"></i>`).join("")}</div>
    <div class="legend">${parts.map((p) => `<span class="c-${p.cls}"><i></i>${p.label} <b>${hrs(p.sec)}</b></span>`).join("")}</div>`;
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
  cue($("setResult").querySelector("b"), "bump");
  // the worker recounts already-scheduled reviews through the new date within a few seconds
  setTimeout(() => load().catch(() => {}), 7000);
}
function shiftGoal(days) {
  if (days < 0 && S.stats.daysLeft <= 1) { limit($("goalMinus"), -1); return; }  // the goal can't go before today
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
function seek(d) {
  wake();
  const atEnd = d < 0 ? video.currentTime <= 0 : video.currentTime >= video.duration - 0.5;
  if (atEnd) { limit($("seek"), Math.sign(d)); return; }
  video.currentTime += d;
  flashPic(`${d < 0 ? "−" : "+"}${Math.abs(d)}`, d < 0 ? "left" : "right");
}
function stepRate(dir) {
  wake();
  const i = Math.max(RATES.indexOf(video.playbackRate), 0), r = RATES[i + dir];
  if (r === undefined) { limit($("rateDD"), dir); flashPic(RATES[i] + "×"); return; }
  setRate(r);
  flashPic(r + "×");
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
  { group: "Video", title: "Mute / unmute", keys: ["M"], when: isVideo, run: () => { video.muted = !video.muted; flashPic(video.muted ? "Muted" : "Sound on"); } },
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
  { group: "Anki", title: "Rebuild VidAnki deck", run: async () => {
    try { const r = await api("/api/rebuild-deck", {}); toast(`VidAnki deck: ${r.cards} cards`); } catch (e) { toast(e.message, true); }
  } },
  { group: "Anki", title: "Refresh card counts", run: async () => { await api("/api/refresh-counts", { block: blockId }); await load(); toast("Card counts refreshed"); } },
  { group: "Items", title: "Hide / show done items", keys: ["H"], run: () => { $("hideDone").checked = !$("hideDone").checked; renderQueue(); } },
  { group: "App", title: "Settings", keys: [","], run: openSettings },
  { group: "App", title: "Goal date: one day later", run: () => shiftGoal(1) },
  { group: "App", title: "Goal date: one day earlier", run: () => shiftGoal(-1) },
  ...Theme.THEMES.map((t) => ({ group: "Look", title: `Theme: ${t.name}`, run: () => setLook("hue", t.hue) })),
  ...Theme.MODES.map((m) => ({ group: "Look", title: `Mode: ${m.label}`, run: () => setLook("mode", m.value) })),
  ...Theme.FONTS.map((f) => ({ group: "Look", title: `Font: ${f.label}`, run: () => setLook("font", f.value) })),
  { group: "App", title: "Sound effects on / off", run: () => { Sound.on = !Sound.on; Sound.play("toggle"); toast(Sound.on ? "Sounds on" : "Sounds off"); } },
  { group: "App", title: "Keyboard shortcuts", keys: ["?"], run: () => openModal("helpModal") },
  { group: "App", title: "Search commands", keys: ["⌘K"], run: () => openPalette() },
];
const KEYMAP = { " ": 0, k: 0, ArrowLeft: 1, ArrowRight: 2, j: 3, l: 4, "[": 5, "]": 6, f: 7, m: 8 };
COMMANDS.forEach((c, i) => {
  const extra = { n: "Next item", p: "Previous item", t: "Start / pause timer", h: "Hide / show done items", ",": "Settings", "?": "Keyboard shortcuts" };
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
function openModal(id) { closeModals(true); $(id).hidden = false; Sound.play("open"); }
function closeModals(silent = false) {
  const open = document.querySelectorAll(".modal:not([hidden])");
  if (open.length && !silent) Sound.play("close");
  open.forEach((m) => (m.hidden = true));
}
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
  if (!p) { limit($("palInput")); return; }  // nothing matches: stay open
  closeModals(true);  // running a command makes its own sound
  p.run();
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
