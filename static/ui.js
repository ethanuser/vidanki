"use strict";
// Custom dropdown: a button plus a square menu, replacing native <select>.
// Arrow keys move, Enter picks, Escape closes.
window.Dropdown = class Dropdown {
  constructor(el, { options = [], value = null, onChange = () => {} } = {}) {
    this.el = el;
    this.onChange = onChange;
    el.innerHTML = `<button type="button" class="dd-btn"><span class="dd-label"></span><span class="dd-caret"></span></button><div class="dd-menu" hidden></div>`;
    this.btn = el.querySelector(".dd-btn");
    this.menu = el.querySelector(".dd-menu");
    this.btn.addEventListener("click", (e) => { e.stopPropagation(); this.menu.hidden ? this.open() : this.close(); });
    this.menu.addEventListener("click", (e) => {
      const li = e.target.closest(".dd-item");
      if (li) { e.stopPropagation(); this.pick(li.dataset.value); }
    });
    this.btn.addEventListener("keydown", (e) => this.key(e));
    this.menu.addEventListener("keydown", (e) => this.key(e));
    document.addEventListener("click", () => this.close());
    this.setOptions(options, value);
  }
  setOptions(options, value = this.value) {
    this.options = options.map((o) => (typeof o === "object" ? o : { value: String(o), label: String(o) }));
    this.menu.innerHTML = this.options
      .map((o) => `<div class="dd-item" tabindex="-1" data-value="${o.value}">${o.label}</div>`).join("");
    this.setValue(value);
  }
  setValue(v) {
    this.value = v == null ? null : String(v);
    const o = this.options.find((x) => x.value === this.value);
    this.el.querySelector(".dd-label").textContent = o ? o.short || o.label : "";
    this.menu.querySelectorAll(".dd-item").forEach((li) => li.classList.toggle("sel", li.dataset.value === this.value));
  }
  pick(v) {
    this.close();
    this.btn.focus();
    if (v !== this.value) { this.setValue(v); this.onChange(v); window.Sound && Sound.play("toggle"); }
  }
  open() {
    document.querySelectorAll(".dd-menu").forEach((m) => (m.hidden = true));
    window.Sound && Sound.play("open");
    this.menu.hidden = false;
    this.el.classList.add("open");
    (this.menu.querySelector(".sel") || this.menu.firstElementChild)?.focus();
  }
  close() { this.menu.hidden = true; this.el.classList.remove("open"); }
  key(e) {
    const items = [...this.menu.querySelectorAll(".dd-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { this.close(); this.btn.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (this.menu.hidden) this.open();
      else items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Enter" && !this.menu.hidden && i >= 0) this.pick(items[i].dataset.value);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
};

// One stroke icon family (24px grid). Play and pause are filled so they read at small sizes.
const ICON_PATHS = {
  play: '<path class="f" d="M7 4v16l13-8z"/>',
  pause: '<rect class="f" x="6" y="4" width="4" height="16" rx="1"/><rect class="f" x="14" y="4" width="4" height="16" rx="1"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  external: '<path d="M7 17 17 7M7 7h10v10"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  back: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  forward: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
};
window.icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
document.querySelectorAll("[data-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

// Styled tooltips: anything with data-tip. A trailing "(X)" renders as a key cap.
(function () {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  document.body.append(tip);
  let target = null, showT = 0, hideT = 0, warmUntil = 0;
  function render(text) {
    const m = text.match(/^(.*?)\s*\(([^()]{1,8})\)$/);
    tip.textContent = m ? m[1] : text;
    if (m) { const k = document.createElement("kbd"); k.textContent = m[2]; tip.append(k); }
  }
  function show() {
    if (!target || !target.isConnected) return;
    render(target.dataset.tip);
    (document.fullscreenElement || document.body).append(tip);  // or it vanishes in fullscreen
    tip.hidden = false;
    const r = target.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    const below = r.bottom + 6 + t.height < innerHeight;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(below ? r.bottom + 6 : r.top - t.height - 6)}px)`;
  }
  function hide() {
    clearTimeout(showT);
    if (!tip.hidden) warmUntil = performance.now() + 600;
    tip.hidden = true;
    target = null;
  }
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (el === target) return;
    clearTimeout(showT); clearTimeout(hideT);
    if (!el || !el.dataset.tip) { hideT = setTimeout(hide, 150); return; }
    target = el;
    if (performance.now() < warmUntil || !tip.hidden) show();
    else showT = setTimeout(show, 400);
  });
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, hide, true));
  document.addEventListener("scroll", hide, true);
})();
