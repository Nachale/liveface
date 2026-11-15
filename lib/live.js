// Gemini Live API client for the browser.
// Microphone -> 16 kHz PCM -> Gemini; Gemini's 24 kHz voice -> speaker (through an analyser
// that drives the lip sync). Handles captions, interruptions and tool calls.

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const CAPTURE_WORKLET = `
// Runs at the phone's own rate (iPhone: 48 kHz) and hands out 16 kHz chunks of 100 ms.
// Each output sample is the average of the input samples it covers (a simple low-pass).
class Cap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; this.buf = new Float32Array(1600); this.n = 0;
    this.acc = 0; this.cnt = 0; this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        this.buf[this.n++] = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pf-capture', Cap);`;

function b64FromInt16(int16) {
  const u8 = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function int16FromB64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int16Array(u8.buffer, 0, u8.length >> 1);
}

export const TOOLS = [{
  functionDeclarations: [
    {
      name: 'set_mood',
      description: 'Change your facial expression to match what you are saying. Call it often, e.g. happy when greeting or joking, surprised at something unexpected, thinking while you consider a question.',
      parameters: {
        type: 'OBJECT',
        properties: { mood: { type: 'STRING', enum: ['happy', 'surprised', 'thinking', 'calm', 'sleepy'] } },
        required: ['mood'],
      },
    },
    {
      name: 'go_to_sleep',
      description: 'End the conversation and go to sleep. Use it after saying a short goodbye when the user says goodbye, thanks you and leaves, or asks you to sleep or stop.',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}];
// live information (weather, news, prices...). Not every Gemini plan allows it in live conversations.
const SEARCH_TOOL = { googleSearch: {} };

// Shared audio engine: created once inside a tap (Chrome needs a user gesture).
export class AudioEngine {
  constructor() {
    // iPhone: let sound play even with the ring/silent switch on, and allow mic + speaker together
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    // both contexts run at the phone's own rate (Safari is unreliable with custom rates);
    // Gemini's 24 kHz voice is resampled by the buffer, the mic is resampled in the worklet
    this.out = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.out.createAnalyser();
    this.analyser.connect(this.out.destination);
    this.mic = new AudioContext();
    this._ready = this.mic.audioWorklet.addModule(
      URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' })));
    this.nextTime = 0;
    this.sources = new Set();
  }
  async resume() { await Promise.all([this.out.resume(), this.mic.resume(), this._ready]); }

  play(int16) {
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
    const buf = this.out.createBuffer(1, f.length, 24000);
    buf.copyToChannel(f, 0);
    const src = this.out.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    const now = this.out.currentTime;
    if (this.nextTime < now + 0.03) this.nextTime = now + 0.06;   // small jitter cushion
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }
  stopPlayback() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    this.nextTime = 0;
  }
  // seconds of voice still queued
  remaining() { return Math.max(0, this.nextTime - this.out.currentTime); }
  get speaking() { return this.remaining() > 0.01; }
}

export class LiveSession extends EventTarget {
  constructor(engine, opts) {
    super();
    this.engine = engine;
    this.o = opts;               // { apiKey, model, voice, system, bargeIn, wsUrl }
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.legacy = false;         // older setup shape (generationConfig) as fallback
    this.lastActivity = performance.now();
    this._sleepAfterSpeech = false;
    this._micQuietUntil = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    await this.engine.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const mic = this.engine.mic;
    this.srcNode = mic.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(mic, 'pf-capture');
    this.worklet.port.onmessage = (e) => this._onMic(e.data);
    this.srcNode.connect(this.worklet);
    // keep the worklet running without making sound
    this.sink = mic.createGain(); this.sink.gain.value = 0;
    this.worklet.connect(this.sink); this.sink.connect(mic.destination);
    this._open();
  }

  _setupMsg() {
    const speech = { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice || 'Aoede' } } };
    const setup = {
      model: 'models/' + (this.o.model || 'gemini-3.8-live'),
      systemInstruction: { parts: [{ text: this.o.system || 'You are a friendly assistant.' }] },
      tools: this.o.search ? [...TOOLS, SEARCH_TOOL] : TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (this.legacy) setup.generationConfig = { responseModalities: ['AUDIO'], speechConfig: speech };
    else { setup.responseModalities = ['AUDIO']; setup.speechConfig = speech; }
    return { setup };
  }

  _open() {
    const url = this.o.wsUrl || (WS_BASE + '?key=' + encodeURIComponent(this.o.apiKey));
    this.emit('status', this.legacy ? 'Connecting (compat mode)…' : 'Connecting…');
    const ws = this.ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify(this._setupMsg()));
    ws.onmessage = async (ev) => {
      const txt = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg; try { msg = JSON.parse(txt); } catch { return; }
      this._onMsg(msg);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.closed) return;
      if (!this.ready && !this.legacy && !/api key|permission|quota|not found|model/i.test(ev.reason || '')) {
        // the server didn't accept the new setup shape - try the older one once
        this.legacy = true; this._open(); return;
      }
      this._finish(this.ready ? 'ended' : 'error', ev.reason || ('connection closed (' + ev.code + ')'));
    };
  }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  sayText(text) {
    if (this.legacy) this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
    else this._send({ realtimeInput: { text } });
  }

  _onMic(f32) {
    if (!this.ready) return;
    const now = performance.now();
    if (this.engine.speaking) this._micQuietUntil = now + 350;   // echo tail
    if (!this.o.bargeIn && now < this._micQuietUntil) return;     // don't let it hear itself
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); i16[i] = v * 32767; }
    this._send({ realtimeInput: { audio: { data: b64FromInt16(i16), mimeType: 'audio/pcm;rate=16000' } } });
  }

  _onMsg(m) {
    if (m.setupComplete) {
      this.ready = true;
      this.emit('ready');
      return;
    }
    if (m.error) { this._finish('error', m.error.message || JSON.stringify(m.error)); return; }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) { this.engine.stopPlayback(); this.emit('interrupted'); }
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data && /audio/.test(p.inlineData.mimeType || 'audio')) {
          this.engine.play(int16FromB64(p.inlineData.data));
          this.lastActivity = performance.now();
        }
      }
      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.lastActivity = performance.now();
        this.emit('you', sc.inputTranscription.text);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) this.emit('bot', sc.outputTranscription.text);
      if (sc.turnComplete) this.emit('turn');
    }
    if (m.toolCall) {
      const responses = [];
      for (const fc of m.toolCall.functionCalls || []) {
        let result = { result: 'ok' };
        if (fc.name === 'set_mood') this.emit('mood', (fc.args && fc.args.mood) || 'happy');
        else if (fc.name === 'go_to_sleep') { this._sleepAfterSpeech = true; result = { result: 'going to sleep' }; }
        else result = { error: 'unknown tool' };
        responses.push({ id: fc.id, name: fc.name, response: result });
      }
      this._send({ toolResponse: { functionResponses: responses } });
      if (this._sleepAfterSpeech) this._sleepWhenQuiet();
    }
    if (m.goAway) this.emit('status', 'Session ending soon');
  }

  _sleepWhenQuiet() {
    const check = () => {
      if (this.closed) return;
      if (this.engine.speaking) setTimeout(check, 250);
      else setTimeout(() => this._finish('sleep'), 600);
    };
    setTimeout(check, 900);   // let the goodbye audio arrive first
  }

  stop() { this._finish('sleep'); }

  _finish(why, reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.ws && this.ws.close(); } catch {}
    try { this.srcNode && this.srcNode.disconnect(); this.worklet && this.worklet.disconnect(); } catch {}
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (why !== 'sleep') this.engine.stopPlayback();
    this.emit('end', { why, reason });
  }
}
