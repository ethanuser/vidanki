"use strict";
// Custom dropdown: a button plus a square menu, replacing native <select>.
// Arrow keys move, Enter picks, Escape closes.
window.Dropdown = class Dropdown {
  constructor(el, { options = [], value = null, onChange = () => {} } = {}) {
    this.el = el;
    this.onChange = onChange;
    el.innerHTML = `<button type="button" class="dd-btn"><span class="dd-label"></span><span class="dd-caret">▾</span></button><div class="dd-menu" hidden></div>`;
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
