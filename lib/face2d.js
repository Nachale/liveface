// PhotoFace: animates a single photo with mouth, blink and eyebrow overlays.
// The overlays are small PNG pieces cut from edited copies of the same photo,
// drawn on top of the base picture on a <canvas>.

const MOUTHS = ['closed', 'slight', 'open', 'wide'];   // face.json "baseMouth" says which one the photo itself shows

export class PhotoFace {
  constructor(canvas, dir = 'face/') {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dir = dir;
    this.img = {};
    this.mouthTarget = 'closed';
    this.w = Object.fromEntries(MOUTHS.map(m => [m, m === 'closed' ? 1 : 0]));
    this.level = 0;              // speech loudness 0..1 (drives head nods)
    this.mood = 'happy';
    this.asleep = true;
    this.sleepFade = 1;          // 1 = fully dark/asleep
    this.blink = 0;              // 0 open .. 1 closed
    this.brows = 0;              // 0 rest .. 1 raised
    this.listening = false;
    this._nextBlink = performance.now() + 1500;
    this._blinkT0 = -1;
    this._double = false;
    this._browKick = 0;
    this._t0 = performance.now();
    this.motion = 0;                 // 0 = picture stays still, 1 = gentle drift
    this._rot = 0; this._dx = 0; this._dy = 0; this._br = 1;
    this._last = this._t0;
  }

  async load() {
    this.meta = await (await fetch(this.dir + 'face.json')).json();
    const names = ['base', ...Object.keys(this.meta.patches)];
    await Promise.all(names.map(n => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(this.img[n] = im);
      im.onerror = () => rej(new Error('missing face image ' + n));
      im.src = this.dir + (n === 'base' ? 'base.jpg' : n + '.png');
    })));
    addEventListener('resize', () => this._resize());
    this._resize();
    const loop = (t) => { this._tick(t); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  // ---- public controls -------------------------------------------------
  setMouth(shape, level = 0) { if (MOUTHS.includes(shape)) this.mouthTarget = shape; this.level = level; }
  setMood(m) { this.mood = m || 'happy'; }
  setAsleep(b) { this.asleep = !!b; if (!b) this._nextBlink = performance.now() + 700; }
  setListening(b) { this.listening = !!b; }
  kickBrows() { this._browKick = 1; }
  setMotion(on) { this.motion = on ? 1 : 0; }

  // ---- internals -------------------------------------------------------
  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.round(innerWidth * dpr);
    this.cv.height = Math.round(innerHeight * dpr);
  }

  _blinkAmount(now) {
    // natural blink: close 70 ms, hold 40 ms, open 120 ms
    if (this._blinkT0 < 0 && now >= this._nextBlink) {
      this._blinkT0 = now;
    }
    if (this._blinkT0 >= 0) {
      const t = now - this._blinkT0;
      let b;
      if (t < 70) b = t / 70;
      else if (t < 110) b = 1;
      else if (t < 230) b = 1 - (t - 110) / 120;
      else {
        b = 0; this._blinkT0 = -1;
        if (!this._double && Math.random() < 0.18) { this._double = true; this._nextBlink = now + 120; }
        else { this._double = false; this._nextBlink = now + 2200 + Math.random() * 4200; }
      }
      return b;
    }
    return 0;
  }

  _tick(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000); this._last = now;
    const t = (now - this._t0) / 1000;

    // mouth weights ease toward the target shape (fast open, a bit slower close)
    for (const m of MOUTHS) {
      const goal = m === this.mouthTarget ? 1 : 0;
      const rate = goal > this.w[m] ? 28 : 18;
      this.w[m] += (goal - this.w[m]) * Math.min(1, rate * dt);
    }

    // sleeping fade
    this.sleepFade += ((this.asleep ? 1 : 0) - this.sleepFade) * Math.min(1, 3 * dt);

    // eyes
    let lids = this._blinkAmount(now);
    let hold = 0;
    if (this.mood === 'sleepy') hold = 0.45;
    if (this.mood === 'thinking') hold = 0.25;
    lids = Math.max(lids, hold, this.sleepFade > 0.5 ? 1 : 0);
    this.blink += (lids - this.blink) * Math.min(1, (lids > this.blink ? 40 : 25) * dt);

    // brows
    this._browKick *= Math.exp(-dt * 2.5);
    let browGoal = this.mood === 'surprised' ? 1 : (this.mood === 'happy' ? 0.15 : 0);
    browGoal = Math.max(browGoal, this._browKick * 0.7);
    if (this.asleep) browGoal = 0;
    this.brows += (browGoal - this.brows) * Math.min(1, 6 * dt);

    // Whole-picture movement. A photo can't turn its head, so any movement shifts the whole
    // frame; it is OFF by default (motion = 0). With motion = 1 it is a very slow, small drift.
    // Every target is eased (never jumps), so nothing snaps sideways.
    let rot = 0, dx = 0, dy = 0, breathe = 1;
    if (this.motion > 0) {
      const m = this.motion;
      rot = m * (0.35 * Math.sin(t * 0.21) + 0.15 * Math.sin(t * 0.47 + 1.3));   // degrees
      dx = m * (2.5 * Math.sin(t * 0.17 + 0.4));
      dy = m * (2 * Math.sin(t * 0.23 + 2.1));
      if (this.mood === 'thinking') rot += m * 1.2;
      if (this.listening) rot -= m * 0.5;
      if (this.asleep) { rot = m * 1.0; dy = m * 4; dx = 0; }
      breathe = 1 + m * 0.003 * Math.sin(t * 1.3);
    }
    const k = Math.min(1, 1.2 * dt);            // ~1 second to settle on a new pose
    this._rot += (rot - this._rot) * k;
    this._dx += (dx - this._dx) * k;
    this._dy += (dy - this._dy) * k;
    this._br += (breathe - this._br) * k;
    this._draw(this._rot, this._dx, this._dy, this._br);
  }

  _draw(rotDeg, dx, dy, breathe) {
    const { ctx, cv, meta } = this;
    const W = cv.width, H = cv.height;
    const iw = meta.width, ih = meta.height;
    // cover-fit with a focus point on the face, plus overscan so motion never shows edges
    const s = Math.max(W / iw, H / ih) * (this.motion ? 1.05 : 1.0) * breathe;
    const [fx, fy] = meta.focus;
    let ox = W / 2 - fx * s, oy = H / 2 - fy * s;
    ox = Math.min(0, Math.max(W - iw * s, ox));
    oy = Math.min(0, Math.max(H - ih * s, oy));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // pivot at the neck
    const [pvx, pvy] = meta.pivot || [565, 760];
    const px = ox + pvx * s, py = oy + pvy * s;
    ctx.translate(px + dx * s, py + dy * s);
    ctx.rotate(rotDeg * Math.PI / 180);
    ctx.translate(-px, -py);
    ctx.translate(ox, oy); ctx.scale(s, s);
    ctx.imageSmoothingQuality = 'high';

    ctx.globalAlpha = 1;
    ctx.drawImage(this.img.base, 0, 0);

    // exact convex blend of mouth shapes (the base photo's own mouth is already drawn)
    const baseMouth = meta.baseMouth || 'open';
    let acc = this.w[baseMouth];
    for (const m of MOUTHS) {
      if (m === baseMouth) continue;
      const w = this.w[m];
      if (w < 0.01) { acc += w; continue; }
      acc += w;
      this._patch('mouth_' + m, Math.min(1, w / Math.max(acc, 1e-4)));
    }
    // eyes
    const b = this.blink;
    if (b > 0.02) {
      this._patch('eyes_half', Math.min(1, b * 2));
      if (b > 0.5) this._patch('eyes_closed', (b - 0.5) * 2);
    }
    if (this.brows > 0.02) this._patch('brows_up', this.brows);

    // sleeping: dim the picture
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.sleepFade > 0.01) {
      ctx.globalAlpha = 0.72 * this.sleepFade;
      ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  _patch(name, alpha) {
    const p = this.meta.patches[name], im = this.img[name];
    if (!p || !im) return;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(im, p.x, p.y);
  }
}
