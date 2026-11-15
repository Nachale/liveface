// LipSync: turns the sound that is actually playing into a mouth shape.
// It listens to an AnalyserNode: loudness picks how open the mouth is,
// and the balance of low vs high frequencies picks round "oh" vs wide "ah".

export class LipSync {
  constructor(analyser) {
    this.an = analyser;
    this.an.fftSize = analyser.context.sampleRate > 32000 ? 2048 : 1024;   // about 40 ms either way
    this.an.smoothingTimeConstant = 0.3;
    this.td = new Float32Array(this.an.fftSize);
    this.fd = new Float32Array(this.an.frequencyBinCount);
    this.peak = 0.08;
    this.level = 0;
    this.shape = 'closed';
    this._hold = 0;
    this.roundAvg = 0;
  }

  update(dt = 1 / 60) {
    const an = this.an;
    an.getFloatTimeDomainData(this.td);
    let sum = 0;
    for (let i = 0; i < this.td.length; i++) sum += this.td[i] * this.td[i];
    const rms = Math.sqrt(sum / this.td.length);

    // automatic gain: follow the loudest recent speech, decay slowly
    this.peak = Math.max(rms, this.peak * Math.exp(-dt * 0.35), 0.02);
    let lv = rms < 0.004 ? 0 : Math.min(1, rms / (this.peak * 0.85));
    const k = lv > this.level ? 0.6 : 0.28;
    this.level += (lv - this.level) * k;

    // spectral balance
    an.getFloatFrequencyData(this.fd);
    const hz = an.context.sampleRate / an.fftSize;
    const band = (a, b) => {
      let s = 0, n = 0;
      for (let i = Math.floor(a / hz); i <= Math.ceil(b / hz) && i < this.fd.length; i++) {
        s += Math.pow(10, this.fd[i] / 20); n++;
      }
      return n ? s / n : 0;
    };
    const low = band(250, 900), high = band(1700, 4500);
    const round = Math.log(low / (high + 1e-6) + 1e-6);
    // compare with this voice's own average, so it works for any voice
    if (this.level > 0.3) this.roundAvg = this.roundAvg ? this.roundAvg + (round - this.roundAvg) * 0.02 : round;
    const dark = round - this.roundAvg;

    let shape;
    const L = this.level;
    if (L < 0.12) shape = 'closed';
    else if (L < 0.32) shape = 'slight';
    else if (L > 0.66) shape = 'wide';
    else shape = 'open';

    // hold each shape at least ~60 ms so it doesn't flicker
    this._hold -= dt;
    if (shape !== this.shape && (this._hold <= 0 || shape === 'closed' && L < 0.05)) {
      this.shape = shape; this._hold = 0.06;
    }
    return { shape: this.shape, level: this.level };
  }
}
