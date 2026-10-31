"use strict";
// The "All done" pictures: flat cut-paper landscapes drawn as SVG, so they need no
// image files and take every color from the theme (the .sc-* classes in style.css).
// All on a 1600x900 canvas: the sun and text sit above the middle, so tall things
// keep to the sides. A scene returns SVG for one random seed.
window.Scenes = (function () {
  const OPEN = 340;  // half-width of the middle kept clear of trees and buildings
  const side = (x) => Math.abs(x - 800) / 800;
  const path = (cls, d) => `<path class="${cls}" d="${d}"/>`;
  const rect = (cls, x, y, w, h, rx = 0) =>
    `<rect class="${cls}" x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="${rx}"/>`;

  // A hill or sea line filled down to the bottom. f(x) gives its height at x.
  function land(cls, f, step = 16) {
    let d = "M0 900";
    for (let x = 0; x <= 1600; x += step) d += `L${x} ${f(x).toFixed(1)}`;
    return path(cls, d + "L1600 900Z");
  }
  // Rolling line from three random sines; rise lifts it toward the sides.
  function rolling(r, base, amp, rise) {
    const [a, b, c] = [r() * 6.3, r() * 6.3, r() * 6.3];
    return (x) => base - rise * side(x) ** 1.6 +
      amp * (0.6 * Math.sin(x * 0.0045 + a) + 0.3 * Math.sin(x * 0.011 + b) + 0.1 * Math.sin(x * 0.027 + c));
  }
  function pine(x, y, h) {
    const w = h * 0.32;
    return `M${x} ${y - h}L${x + w * 0.7} ${y - h * 0.55}L${x + w * 0.4} ${y - h * 0.55}L${x + w} ${y - h * 0.1}L${x - w} ${y - h * 0.1}` +
      `L${x - w * 0.4} ${y - h * 0.55}L${x - w * 0.7} ${y - h * 0.55}ZM${x - w * 0.12} ${y - h * 0.1}h${w * 0.24}v${h * 0.15}h${-w * 0.24}Z`;
  }
  // Pines along a line, on both sides of the middle, skipping the spots in avoid.
  function pines(r, cls, f, n, size, avoid = []) {
    let d = "";
    for (let i = 0; i < n; i++) {
      const x = r() < 0.5 ? r() * (800 - OPEN) : 800 + OPEN + r() * (800 - OPEN);
      if (avoid.some((a) => Math.abs(x - a) < 120)) continue;
      d += pine(Math.round(x), Math.round(f(x) + 8), size * (0.75 + r() * 0.6));
    }
    return path(cls, d);
  }
  // The sun's reflection: dashes that widen toward the viewer.
  function glints(r, top, n) {
    let s = "";
    for (let i = 0; i < n; i++) {
      const w = (50 + i * 26) * (0.7 + r() * 0.6);
      s += rect("sc-glow", 800 - w / 2 + (r() - 0.5) * 24, top + i * 24, w, 5, 2.5);
    }
    return s;
  }
  function sky(r) {
    let s = "";
    for (let i = 0; i < 26; i++) {  // stars keep to the sides of the sun
      const x = r() < 0.5 ? 40 + r() * 470 : 1090 + r() * 470;
      s += `<circle class="sc-star" cx="${x.toFixed(0)}" cy="${(30 + r() * 400).toFixed(0)}" r="${(1.5 + r() * 2).toFixed(1)}"/>`;
    }
    for (const [cx, y, w] of [[230, 180, 240], [1290, 120, 200], [1120, 320, 150]]) {
      const x = cx + (r() - 0.5) * 80;
      s += rect("sc-cloud", x, y, w, 26, 13) + rect("sc-cloud", x + w * 0.2, y - 20, w * 0.5, 26, 13);
    }
    return s;
  }

  const SCENES = {
    // Layered hills and a cabin with its light on.
    cabin(r) {
      const cabin = Math.round(400 + r() * 120);
      let s = "";
      [0, 1, 2, 3, 4].forEach((i) => {
        const f = rolling(r, 610 + i * 56, 34 - i * 3, 150 - i * 18);
        s += land(`sc-${i + 1}`, f);
        if (i >= 2) s += pines(r, `sc-${i + 1}`, f, 7 + i * 3, 40 + i * 13, [cabin]);
        if (i === 3) {
          const y = Math.round(f(cabin)) + 6;
          s += path("sc-5", `M${cabin - 46} ${y}v-44l46-34l46 34v44ZM${cabin + 20} ${y - 80}h14v30h-14Z`);
          s += rect("sc-glow", cabin - 12, y - 34, 24, 20, 2);
        }
      });
      return s;
    },

    // A still lake below the mountains, with a canoe.
    lake(r) {
      let s = land("sc-1", rolling(r, 620, 30, 190)) + land("sc-2", rolling(r, 660, 24, 120));
      const shore = rolling(r, 700, 6, 30);
      s += land("sc-3", shore) + pines(r, "sc-3", shore, 16, 62);
      s += rect("sc-water", 0, 716, 1600, 184) + glints(r, 730, 7);
      const left = (x) => 720 + 190 * (x / 520) ** 1.8, right = (x) => left(1600 - x);
      s += path("sc-5", `M0 900L0 720Q300 740 520 900Z`) + path("sc-5", `M1600 900L1600 700Q1300 730 1080 900Z`);
      for (let i = 0; i < 7; i++) {
        const x = 20 + r() * 300;
        s += path("sc-5", pine(Math.round(x), Math.round(left(x) + 10), 90 + r() * 70));
        const y = 1580 - r() * 300;
        s += path("sc-5", pine(Math.round(y), Math.round(right(y) + 10), 90 + r() * 70));
      }
      const c = 1020 + r() * 90;
      s += path("sc-5", `M${c - 60} 786q60 26 120 0q-60 8 -120 0ZM${c} 792l-4 -26h8l4 26Z`);
      return s;
    },

    // A lighthouse on the cliffs, and a sailboat.
    coast(r) {
      const flip = r() < 0.5 ? ' transform="translate(1600 0) scale(-1 1)"' : "";
      let s = rect("sc-water", 0, 640, 1600, 260) + glints(r, 652, 3);
      [[706, "sc-2", 7], [770, "sc-3", 9], [836, "sc-4", 11]].forEach(([y, cls, amp]) => {
        const p = r() * 6.3;
        s += land(cls, (x) => y + amp * Math.sin(x * 0.03 + p) + amp * 0.6 * Math.sin(x * 0.011 + p), 8);
      });
      const boat = 1190 + r() * 90;
      s += `<g${flip}>` +
        path("sc-4", "M0 900L0 560L260 540Q420 560 500 660Q570 760 560 900Z") +
        path("sc-5", "M0 900L0 470L150 452Q330 450 390 520Q430 570 450 660Q480 780 420 900Z") +
        '<g transform="translate(130 30)">' +
        path("sc-1", "M96 426L108 268h44L164 426Z") +
        path("sc-3", "M104 320h52l3 36h-58ZM99 390h62l3 36h-68Z") +
        rect("sc-5", 100, 260, 60, 10) + rect("sc-glow", 110, 228, 40, 32, 2) +
        path("sc-5", "M100 228L130 196L160 228Z") + "</g>" +
        path("sc-5", `M${boat - 50} 690h100l-20 24h-60Z`) +
        path("sc-1", `M${boat - 4} 684v-92l-54 92Z`) + path("sc-2", `M${boat + 4} 684v-74l42 74Z`) +
        "</g>";
      return s;
    },

    // Snowy peaks and a tent at the tree line.
    peaks(r) {
      let s = "";
      [[730, "sc-1", 8, 1], [790, "sc-2", 7, 0.8]].forEach(([base, cls, n, scale]) => {
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 1600 + (r() - 0.5) * 60;
          const h = (120 + 340 * side(x)) * scale * (0.85 + r() * 0.3), w = h * 1.15, top = base - h;
          s += path(cls, `M${x - w} ${base}L${x} ${top}L${x + w} ${base}Z`);
          const t = 0.3, cy = top + h * t, dx = w * t;  // a zigzag snow line across the top
          s += path("sc-snow", `M${x} ${top}L${x + dx} ${cy}L${x + dx * 0.45} ${cy - h * 0.05}L${x + dx * 0.1} ${cy + h * 0.03}L${x - dx * 0.35} ${cy - h * 0.05}L${x - dx} ${cy}Z`);
        }
      });
      const mid = rolling(r, 770, 18, 40), near = rolling(r, 830, 16, 50);
      s += land("sc-3", mid) + pines(r, "sc-3", mid, 16, 70);
      const tent = 1090 + r() * 120;
      s += land("sc-4", near);
      const y = Math.round(near(tent)) + 4;
      s += path("sc-5", `M${tent - 62} ${y}L${tent} ${y - 66}L${tent + 62} ${y}Z`) + path("sc-glow", `M${tent - 20} ${y}L${tent} ${y - 40}L${tent + 20} ${y}Z`);
      s += pines(r, "sc-4", near, 12, 96, [tent]);
      s += land("sc-5", rolling(r, 880, 8, 30));
      return s;
    },

    // A small town with its windows lit.
    town(r) {
      const row = (base, cls, lit, grow) => {
        let s = "", x = -30;
        while (x < 1620) {
          const w = 70 + r() * 60, c = x + w / 2, h = 46 + r() * 50 + grow * side(c) ** 1.4;
          const roof = 22 + r() * 16, chimney = r() < 0.4;
          s += path(cls, `M${x} ${base + 80}V${base - h}L${c} ${base - h - roof}L${x + w} ${base - h}V${base + 80}Z` +
            (chimney ? `M${x + w * 0.7} ${base - h}v${-roof * 0.9}h12v${roof * 0.9}Z` : ""));
          for (let wy = base - h + 12; lit && wy < base - 10; wy += 30) {
            for (const wx of [x + w * 0.22, x + w * 0.62]) {
              if (r() < lit) s += rect("sc-glow", wx, wy, 13, 17, 1);
            }
          }
          x += w + r() * 10;
        }
        return s;
      };
      let s = land("sc-1", rolling(r, 640, 20, 110));
      s += row(690, "sc-2", 0, 150);
      const spire = 1140 + r() * 120;  // the church stands above the roofs
      s += path("sc-3", `M${spire - 34} 800V540L${spire} 400L${spire + 34} 540V800Z`) + rect("sc-glow", spire - 9, 556, 18, 30, 9);
      s += row(750, "sc-3", 0.28, 120) + row(820, "sc-4", 0.42, 90);
      s += land("sc-5", rolling(r, 870, 8, 16));
      s += pines(r, "sc-5", rolling(r, 874, 0, 16), 8, 96);
      return s;
    },
  };

  const names = Object.keys(SCENES);
  return {
    names,
    // Any scene but the one shown last, so it changes every time.
    pick() {
      let last = null;
      try { last = localStorage.getItem("vidanki.scene"); } catch {}
      const rest = names.filter((n) => n !== last);
      const name = rest[Math.floor(Math.random() * rest.length)];
      try { localStorage.setItem("vidanki.scene", name); } catch {}
      return name;
    },
    draw(name, seed = Math.random() * 2 ** 32) {
      const r = () => {  // small seeded random, so tests can repeat a picture
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return sky(r) + SCENES[name](r);
    },
  };
})();
