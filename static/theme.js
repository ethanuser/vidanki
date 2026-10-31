"use strict";
// The look of the app. One hue tints every surface, the accent and the smart dark
// video (the tokens are in style.css), so a theme is just a hue. Mode and font sit
// on <html>. Saved per device, like sound. Loaded in <head> so the first paint is right.
window.Theme = (function () {
  const THEMES = [
    { id: "hearth", name: "Hearth", hue: 45 },
    { id: "honey", name: "Honey", hue: 80 },
    { id: "moss", name: "Moss", hue: 135 },
    { id: "tide", name: "Tide", hue: 205 },
    { id: "slate", name: "Slate", hue: 255 },
    { id: "dusk", name: "Dusk", hue: 305 },
    { id: "rose", name: "Rose", hue: 5 },
  ];
  const MODES = [{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
  const FONTS = [{ value: "cozy", label: "Cozy" }, { value: "book", label: "Book" }, { value: "plain", label: "Plain" }];

  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const pref = (() => {
    try { return JSON.parse(localStorage.getItem("vidanki.look")) || {}; } catch { return {}; }
  })();
  let hue = typeof pref.hue === "number" ? pref.hue : THEMES[0].hue;
  let mode = MODES.some((m) => m.value === pref.mode) ? pref.mode : "auto";
  let font = FONTS.some((f) => f.value === pref.font) ? pref.font : "cozy";
  const listeners = [];

  const isDark = () => (mode === "auto" ? system.matches : mode === "dark");
  function apply() {
    root.style.setProperty("--h", hue);
    root.dataset.mode = isDark() ? "dark" : "light";
    root.dataset.font = font;
    const icon = document.querySelector("link[rel=icon]");
    if (icon) {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M4 2l10 6-10 6z' fill='oklch(.66 .125 ${hue})'/></svg>`;
      icon.href = "data:image/svg+xml," + encodeURIComponent(svg);
    }
  }
  function changed() {
    apply();
    try { localStorage.setItem("vidanki.look", JSON.stringify({ hue, mode, font })); } catch {}
    listeners.forEach((fn) => fn());
  }
  system.addEventListener("change", () => {
    if (mode !== "auto") return;
    apply();
    listeners.forEach((fn) => fn());
  });
  apply();

  return {
    THEMES, MODES, FONTS,
    onChange(fn) { listeners.push(fn); },
    get dark() { return isDark(); },
    get theme() { return THEMES.find((t) => t.hue === hue)?.id || "custom"; },
    get hue() { return hue; },
    set hue(v) { hue = Math.round(v); changed(); },
    get mode() { return mode; },
    set mode(v) { mode = v; changed(); },
    get font() { return font; },
    set font(v) { font = v; changed(); },
  };
})();
