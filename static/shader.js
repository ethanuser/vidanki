// "Smart dark" renderer: draws the video through a WebGL shader that flips
// lightness for neutral pixels (white board -> near black, black ink -> light)
// while keeping coloured pixels' hue and chroma, like Dark Reader does for pages.
// Dark coloured ink is lifted so it stays readable on the dark background.
window.SmartDark = (function () {
  const VS = `
    attribute vec2 p;
    varying vec2 uv;
    void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS = `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform float bg;   // output lightness for pure white (OKLab L)
    uniform float fg;   // output lightness for pure black
    uniform vec4 crop;  // picture area inside the frame (x0, y0, x1, y1); outside = black bars
    uniform float plain; // 1 = plain invert (lightness flip, hue kept), 0 = smart dark

    vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
    vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

    vec3 toOklab(vec3 c) {
      float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
      float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
      float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
      l = pow(l, 1.0 / 3.0); m = pow(m, 1.0 / 3.0); s = pow(s, 1.0 / 3.0);
      return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                  1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                  0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
    }
    vec3 fromOklab(vec3 c) {
      float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
      float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
      float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
      l = l * l * l; m = m * m * m; s = s * s * s;
      return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                  -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                  -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    }

    void main() {
      // letterbox / pillarbox bars baked into the video stay black, not flipped to white
      if (uv.x < crop.x || uv.x > crop.z || uv.y < crop.y || uv.y > crop.w) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec3 c = texture2D(tex, uv).rgb;
      vec3 lab = toOklab(toLin(c));
      float L = lab.x;
      if (plain > 0.5) {
        lab.x = 1.0 - L;
        gl_FragColor = vec4(toSrgb(clamp(fromOklab(lab), 0.0, 1.0)), 1.0);
        return;
      }
      float C = length(lab.yz);
      float inv = mix(fg, bg, L);                  // neutral: flip lightness
      float keep = clamp(max(inv, L), 0.0, 0.86);  // colour: keep, but lift dark ink
      // Very light colours (highlighter, pastel boxes) are backgrounds, not ink:
      // darken them like white so the black text on them (now light) stays readable.
      float fill = smoothstep(0.78, 0.9, L);
      keep = mix(keep, max(inv, 0.26), fill);
      lab.yz *= mix(1.0, 0.65, fill);              // less chroma so dark fills stay in gamut
      float w = smoothstep(0.035, 0.11, C);        // how "coloured" the pixel is
      lab.x = mix(inv, keep, w);
      gl_FragColor = vec4(toSrgb(clamp(fromOklab(lab), 0.0, 1.0)), 1.0);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function create(canvas, video) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1f(gl.getUniformLocation(prog, "bg"), 0.17);
    gl.uniform1f(gl.getUniformLocation(prog, "fg"), 0.93);
    const uCrop = gl.getUniformLocation(prog, "crop"), uPlain = gl.getUniformLocation(prog, "plain");
    gl.uniform4f(uCrop, 0, 0, 1, 1);
    gl.uniform1f(uPlain, 0);

    // Find black bars at the frame edges from a small copy of the frame: rows or
    // columns whose brightest pixel is near black. A bar must show up twice in a
    // row before it's used, so a dark scene doesn't get clipped.
    const probe = document.createElement("canvas");
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    let crop = [0, 0, 1, 1], candidate = null, lastProbe = 0;
    function detectBars() {
      if (video.readyState < 2 || !video.videoWidth) return;
      const W = 96, H = Math.max(8, Math.round(96 * video.videoHeight / video.videoWidth));
      probe.width = W; probe.height = H;
      try { pctx.drawImage(video, 0, 0, W, H); } catch { return; }
      const d = pctx.getImageData(0, 0, W, H).data;
      const lum = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
      const colMax = (x) => { let m = 0; for (let y = 0; y < H; y++) m = Math.max(m, lum(x, y)); return m; };
      const rowMax = (y) => { let m = 0; for (let x = 0; x < W; x++) m = Math.max(m, lum(x, y)); return m; };
      const DARK = 22;
      let l = 0, r = W - 1, t = 0, b = H - 1;
      while (l < W / 2 && colMax(l) < DARK) l++;
      while (r > W / 2 && colMax(r) < DARK) r--;
      while (t < H / 2 && rowMax(t) < DARK) t++;
      while (b > H / 2 && rowMax(b) < DARK) b--;
      if (l >= W / 2 - 1 || t >= H / 2 - 1) return;  // all dark (a fade): keep what we had
      // bars thinner than ~2% are just a dark edge of the picture; ignore them
      const minX = Math.ceil(W * 0.02), minY = Math.ceil(H * 0.02);
      const next = [l >= minX ? l / W : 0, t >= minY ? t / H : 0,
                    W - 1 - r >= minX ? (r + 1) / W : 1, H - 1 - b >= minY ? (b + 1) / H : 1];
      const same = (a, c) => a && a.every((v, i) => Math.abs(v - c[i]) < 0.015);
      if (same(candidate, next) && !same(crop, next)) { crop = next; gl.useProgram(prog); gl.uniform4f(uCrop, ...crop); kick(); }
      candidate = next;
    }
    // a paused frame (just loaded or seeked) won't be probed again by playback,
    // so probe it twice to pass the "seen twice" check
    const probeNow = () => setTimeout(() => { detectBars(); detectBars(); }, 250);
    video.addEventListener("loadeddata", () => { crop = [0, 0, 1, 1]; candidate = null; gl.useProgram(prog); gl.uniform4f(uCrop, 0, 0, 1, 1); probeNow(); });
    video.addEventListener("seeked", probeNow);

    let running = false;
    const useVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

    function draw() {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        // letterbox like object-fit: contain
        const s = Math.min(cw / video.videoWidth, ch / video.videoHeight);
        const w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport((cw - w) >> 1, (ch - h) >> 1, w, h);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const now = performance.now();
        if (now - lastProbe > 1500) { lastProbe = now; detectBars(); }
      }
    }
    // While playing, draw every decoded frame; while paused, draw only when the
    // picture changes (seek, load, resize) so a paused video costs nothing.
    let pending = false;
    function loop() {
      pending = false;
      draw();
      if (running && !video.paused && !video.ended) {
        pending = true;
        if (useVFC) video.requestVideoFrameCallback(loop);
        else requestAnimationFrame(loop);
      }
    }
    function kick() { if (running && !pending) { pending = true; requestAnimationFrame(loop); } }
    ["play", "seeked", "loadeddata"].forEach((ev) => video.addEventListener(ev, kick));
    video.addEventListener("seeked", () => { lastProbe = 0; });
    // a pending frame callback may never fire once paused; don't let it block redraws
    video.addEventListener("pause", () => { pending = false; kick(); });
    new ResizeObserver(kick).observe(canvas);
    return {
      start() { running = true; kick(); },
      setPlain(v) { gl.useProgram(prog); gl.uniform1f(uPlain, v ? 1 : 0); kick(); },
      stop() { running = false; },
      redraw: kick,
    };
  }
  return { create };
})();
