// Sidetones. Each player has a voice: { freq, wave }.
const Sound = (() => {
  let ac = null, master = null, volume = 0.5;
  const WAVE_GAIN = { sine: 1, triangle: 0.9, square: 0.3, sawtooth: 0.36 };
  const BUFFER = 0.12;   // seconds of jitter buffer for live remote keying
  const streams = {};    // pid -> { offset, last, cur, next }

  function ensure() {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ac = new Ctx();
      master = ac.createGain();
      master.gain.value = volume * 0.6;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function setVolume(v) {
    volume = v;
    if (master) master.gain.value = v * 0.6;
  }

  // Start a tone at time `at`; returns { stop(t) }.
  function tone(voice, at) {
    const level = 0.5 * (WAVE_GAIN[voice.wave] || 1);
    const o = ac.createOscillator();
    o.type = voice.wave;
    o.frequency.value = voice.freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.005);
    o.connect(g).connect(master);
    o.start(at);
    let stopped = false;
    const safety = setTimeout(() => stop(ac.currentTime), 5000);
    function stop(t) {
      if (stopped) return;
      stopped = true;
      clearTimeout(safety);
      t = Math.max(t, at + 0.012);
      g.gain.setValueAtTime(level, t);
      g.gain.linearRampToValueAtTime(0, t + 0.006);
      o.stop(t + 0.03);
    }
    return { stop };
  }

  // ---- Your own key: immediate ----
  let self = null;
  function selfDown(voice) {
    if (!ensure()) return;
    if (self) self.stop(ac.currentTime);
    self = tone(voice, ac.currentTime);
  }
  function selfUp() {
    if (self && ac) self.stop(ac.currentTime);
    self = null;
  }

  // ---- Someone else's key, exactly as they keyed it ----
  // `kt` is the keyer's own clock in ms. The first event of a burst sets an
  // offset (plus a small buffer); later events keep the keyer's real rhythm.
  function remoteTime(s, kt) {
    const now = ac.currentTime, k = kt / 1000;
    if (s.offset === undefined || now - s.last > 1.5) s.offset = now + BUFFER - k;
    let t = k + s.offset;
    if (t < now + 0.005) { s.offset += now + 0.02 - t; t = k + s.offset; }
    s.last = now;
    return t;
  }
  function remoteDown(pid, voice, kt) {
    if (!ensure()) return;
    const s = streams[pid] || (streams[pid] = {});
    const t = remoteTime(s, kt);
    if (s.cur) s.cur.stop(t);
    s.cur = tone(voice, t);
  }
  function remoteUp(pid, kt) {
    const s = streams[pid];
    if (!ac || !s || !s.cur) return;
    s.cur.stop(remoteTime(s, kt));
    s.cur = null;
  }

  // ---- A letter played back with perfect timing ----
  function playCode(pid, voice, code, wpm) {
    if (!ensure()) return;
    const u = 1.2 / wpm;
    const s = streams['clean:' + pid] || (streams['clean:' + pid] = {});
    let t = Math.max(ac.currentTime + 0.03, s.next || 0);
    for (const c of code) {
      const d = c === '.' ? u : 3 * u;
      tone(voice, t).stop(t + d);
      t += d + u;
    }
    s.next = t + 2 * u;
  }

  return { ensure, setVolume, selfDown, selfUp, remoteDown, remoteUp, playCode };
})();
