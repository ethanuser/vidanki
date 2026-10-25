"use strict";
// Small UI sounds, synthesized with Web Audio (no audio files). Soft and short on
// purpose: a quiet tick for navigation, a blip for toggles, and a warm chime only
// for finishing things. Volume and on/off live in localStorage (per device).
window.Sound = (function () {
  let ctx = null, master = null;
  const pref = (() => {
    try { return JSON.parse(localStorage.getItem("vidanki.sound")) || {}; } catch { return {}; }
  })();
  let on = pref.on !== false;
  let volume = typeof pref.volume === "number" ? pref.volume : 0.6;

  function save() {
    try { localStorage.setItem("vidanki.sound", JSON.stringify({ on, volume })); } catch {}
  }
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume * 0.5;  // headroom: everything here is meant to be quiet
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One soft note: sine/triangle with a quick attack and an exponential tail.
  function note(freq, start, dur, { type = "sine", gain = 0.25, attack = 0.005 } = {}) {
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  // A short pitch glide, for start/pause.
  function glide(from, to, dur, gain = 0.18) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const SOUNDS = {
    // moving around: barely there
    select: () => note(1320, 0, 0.045, { gain: 0.07 }),
    // checkboxes, dropdowns, opening panels
    toggle: () => { note(880, 0, 0.05, { gain: 0.08 }); note(1175, 0.035, 0.06, { gain: 0.06 }); },
    open: () => note(990, 0, 0.07, { gain: 0.07, type: "triangle" }),
    // timer
    start: () => glide(520, 820, 0.12),
    pause: () => glide(820, 520, 0.12),
    // saving an edit, rebuilding, small confirmations
    confirm: () => { note(784, 0, 0.12, { gain: 0.12 }); note(1047, 0.06, 0.16, { gain: 0.1 }); },
    // finishing an item: warm major arpeggio with a soft triangle shimmer
    done: () => {
      [523.25, 659.25, 783.99].forEach((f, i) => note(f, i * 0.07, 0.45, { gain: 0.16 }));
      note(1567.98, 0.21, 0.5, { gain: 0.05, type: "triangle" });
    },
    // finishing a whole section, or clearing the Anki gate: a fuller, longer chord
    milestone: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.08, 0.9, { gain: 0.15 }));
      [1318.5, 1567.98].forEach((f, i) => note(f, 0.36 + i * 0.07, 0.8, { gain: 0.05, type: "triangle" }));
    },
    // something went wrong: low and short, not a buzzer
    error: () => { note(220, 0, 0.14, { gain: 0.14, type: "triangle" }); note(185, 0.08, 0.18, { gain: 0.1, type: "triangle" }); },
  };

  return {
    play(name) {
      if (!on || !SOUNDS[name]) return;
      if (!audio()) return;
      try { SOUNDS[name](); } catch (e) { console.warn("sound", e); }
    },
    get on() { return on; },
    set on(v) { on = !!v; save(); },
    get volume() { return volume; },
    set volume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume * 0.5;
      save();
    },
  };
})();
