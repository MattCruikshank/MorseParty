// The room: game rules and shared state. Runs only in the host's browser.
// Every participant (including the host) talks to it with the same messages;
// it answers through the `send(pid, msg)` function it was given.

// Tone and color for each player, assigned so online players never share one.
const VOICES = [
  { freq: 600, wave: 'sine',     color: '#e4572e' },
  { freq: 780, wave: 'triangle', color: '#2e86de' },
  { freq: 480, wave: 'square',   color: '#20a464' },
  { freq: 900, wave: 'sine',     color: '#a55eea' },
  { freq: 680, wave: 'sawtooth', color: '#e1a100' },
  { freq: 540, wave: 'triangle', color: '#d6336c' },
  { freq: 840, wave: 'square',   color: '#0f9fb5' },
  { freq: 430, wave: 'sine',     color: '#7a6a58' },
];

const RACE_REVEAL_MS = 6000;   // unguessed letters are revealed after this
const LOCKOUT_MS = 1000;       // after a wrong guess
const PENDING_MS = 4000;       // guesses typed while a letter is still being keyed
const TAPE_MAX = 400;

class Room {
  constructor(send) {
    this.send = send;
    this.mode = 'race';
    this.players = new Map();   // pid -> player
    this.tapes = new Map();     // pid -> [item]
    this.nextItem = 1;
    this.pending = [];          // [{pid, ch, at}]
  }

  // ---------- helpers ----------
  online() { return [...this.players.values()].filter(p => p.online); }

  publicPlayer(p) {
    return { pid: p.pid, name: p.name, voice: p.voice, score: p.score, online: p.online, wpm: p.wpm };
  }

  view(item, viewer, owner) {
    const v = { id: item.id, state: item.state, code: item.code, typed: !!item.typed };
    if (item.state !== 'open' || viewer === owner) v.ch = item.ch;
    if (item.by) { v.by = item.by; v.ms = item.ms; }
    return v;
  }

  broadcast(msg, except) {
    for (const p of this.online()) if (p.pid !== except) this.send(p.pid, msg);
  }

  sendPlayers() {
    this.broadcast({ t: 'players', players: [...this.players.values()].map(p => this.publicPlayer(p)) });
  }

  sendItem(owner, item, isNew) {
    for (const p of this.online()) {
      this.send(p.pid, { t: 'item', pid: owner, item: this.view(item, p.pid, owner), isNew: !!isNew });
    }
  }

  snapshot(viewer) {
    const tapes = {};
    for (const [pid, items] of this.tapes) tapes[pid] = items.map(it => this.view(it, viewer, pid));
    return {
      t: 'welcome', you: viewer, mode: this.mode,
      players: [...this.players.values()].map(p => this.publicPlayer(p)), tapes,
    };
  }

  tape(pid) {
    if (!this.tapes.has(pid)) this.tapes.set(pid, []);
    return this.tapes.get(pid);
  }

  addItem(pid, fields) {
    const item = { id: this.nextItem++, at: Date.now(), ...fields };
    const t = this.tape(pid);
    t.push(item);
    if (t.length > TAPE_MAX) t.splice(0, t.length - TAPE_MAX);
    this.sendItem(pid, item, true);
    return item;
  }

  pickVoice(p) {
    const used = new Set(this.online().filter(o => o !== p).map(o => o.voice));
    if (p.voice !== undefined && !used.has(p.voice)) return p.voice;
    for (let i = 0; i < VOICES.length; i++) if (!used.has(i)) return i;
    return this.players.size % VOICES.length;
  }

  // ---------- connection lifecycle ----------
  join(pid, name, wpm) {
    let p = this.players.get(pid);
    if (!p) {
      p = { pid, score: 0, keying: false, keyingAt: 0, lockUntil: 0 };
      this.players.set(pid, p);
    }
    p.name = String(name || 'Player').slice(0, 24);
    p.wpm = clampWpm(wpm);
    p.online = true;
    p.voice = this.pickVoice(p);
    this.send(pid, this.snapshot(pid));
    this.sendPlayers();
  }

  leave(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    p.online = false;
    p.keying = false;
    this.sendPlayers();
  }

  // ---------- messages ----------
  handle(pid, msg) {
    const p = this.players.get(pid);
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') return this.join(pid, msg.name, msg.wpm);
    if (!p || !p.online) return;

    switch (msg.t) {
      case 'name':
        p.name = String(msg.name || 'Player').slice(0, 24);
        return this.sendPlayers();
      case 'wpm':
        p.wpm = clampWpm(msg.wpm);
        return this.sendPlayers();

      case 'down':
      case 'up':
        p.keying = true;
        p.keyingAt = Date.now();
        return this.broadcast({ t: msg.t, pid, kt: +msg.kt, sym: msg.sym === '-' ? '-' : '.' }, pid);

      case 'letter': return this.onLetter(p, String(msg.code || ''), msg.ch ? String(msg.ch) : null);
      case 'space':  return this.onSpace(p);
      case 'guess':  return this.onGuess(p, String(msg.ch || '').toUpperCase().slice(0, 1));
      case 'type':   return this.onType(p, String(msg.ch || '').slice(0, 1));
      case 'backspace': return this.onBackspace(p);

      case 'mode':
        if (msg.mode !== 'race' && msg.mode !== 'chat') return;
        this.mode = msg.mode;
        this.revealAllOpen();
        return this.broadcast({ t: 'mode', mode: this.mode, by: p.name });
      case 'clear':
        this.tapes.clear();
        this.pending = [];
        for (const p2 of this.online()) this.send(p2.pid, { t: 'tapes', tapes: {}, by: p.name });
        return;
      case 'resetScores':
        for (const q of this.players.values()) q.score = 0;
        return this.sendPlayers();
    }
  }

  onLetter(p, code, ch) {
    if (!/^[.-]{1,8}$/.test(code)) return;
    p.keying = false;
    this.broadcast({ t: 'play', pid: p.pid, code, wpm: p.wpm, kind: 'key' }, p.pid);
    if (!ch || !MORSE_CODE_TO_CHAR[code]) {
      this.addItem(p.pid, { ch: '?', code, state: 'bad' });
      return;
    }
    ch = MORSE_CODE_TO_CHAR[code]; // trust the table, not the client
    if (this.mode === 'chat') {
      this.addItem(p.pid, { ch, code, state: 'sent' });
      return;
    }
    const item = this.addItem(p.pid, { ch, code, state: 'open' });
    item.timer = setTimeout(() => {
      if (item.state !== 'open') return;
      item.state = 'missed';
      this.sendItem(p.pid, item);
    }, RACE_REVEAL_MS);

    // Guesses typed while this letter was still being keyed.
    const now = Date.now();
    this.pending = this.pending.filter(g => now - g.at < PENDING_MS);
    const hit = this.pending.find(g => g.pid !== p.pid && g.ch === ch);
    if (hit) {
      this.pending = this.pending.filter(g => g !== hit);
      this.win(this.players.get(hit.pid), p.pid, item, 0);
    }
  }

  onSpace(p) {
    p.keying = false;
    const t = this.tape(p.pid);
    const last = t[t.length - 1];
    if (last && last.ch !== ' ') this.addItem(p.pid, { ch: ' ', code: '', state: this.mode === 'chat' ? 'sent' : 'space' });
  }

  openItems() {
    const out = [];
    for (const [owner, items] of this.tapes) {
      for (const it of items) if (it.state === 'open') out.push({ owner, it });
    }
    return out.sort((a, b) => a.it.at - b.it.at);
  }

  onGuess(p, ch) {
    if (this.mode !== 'race' || !ch) return;
    const now = Date.now();
    if (now < p.lockUntil) return this.send(p.pid, { t: 'guess', ch, result: 'locked', lockMs: p.lockUntil - now });

    const open = this.openItems().filter(o => o.owner !== p.pid);
    const match = open.find(o => o.it.ch === ch);
    if (match) return this.win(p, match.owner, match.it, now - match.it.at);

    const someoneKeying = this.online().some(o => o.pid !== p.pid && o.keying && now - o.keyingAt < 5000);
    if (someoneKeying) {
      this.pending.push({ pid: p.pid, ch, at: now });
      return this.send(p.pid, { t: 'guess', ch, result: 'pending' });
    }
    if (open.length === 0) return this.send(p.pid, { t: 'guess', ch, result: 'nothing' });

    p.lockUntil = now + LOCKOUT_MS;
    this.send(p.pid, { t: 'guess', ch, result: 'wrong', lockMs: LOCKOUT_MS });
  }

  win(winner, owner, item, ms) {
    clearTimeout(item.timer);
    item.state = 'won';
    item.by = winner.pid;
    item.ms = Math.max(0, Math.round(ms));
    winner.score++;
    this.send(winner.pid, { t: 'guess', ch: item.ch, result: 'right', ms: item.ms });
    this.sendItem(owner, item);
    this.sendPlayers();
  }

  revealAllOpen() {
    for (const { owner, it } of this.openItems()) {
      clearTimeout(it.timer);
      it.state = 'missed';
      this.sendItem(owner, it);
    }
  }

  onType(p, ch) {
    if (this.mode !== 'chat' || !ch) return;
    const up = ch.toUpperCase();
    const code = MORSE_CHAR_TO_CODE[up] || '';
    this.addItem(p.pid, { ch: ch === ' ' ? ' ' : up, code, state: 'sent', typed: true });
    if (code) this.broadcast({ t: 'play', pid: p.pid, code, wpm: p.wpm, kind: 'typed' }, p.pid);
  }

  onBackspace(p) {
    const t = this.tape(p.pid);
    const last = t[t.length - 1];
    if (!last || !last.typed) return;
    t.pop();
    this.broadcast({ t: 'remove', pid: p.pid, id: last.id });
  }
}

function clampWpm(w) {
  w = Math.round(+w || 12);
  return Math.min(40, Math.max(5, w));
}
