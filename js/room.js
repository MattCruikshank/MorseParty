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
const TEAM_REVEAL_MS = 8000;   // Team: a letter closes after this, or once everyone has guessed
const CHALLENGE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MOLE_MS = 15000;         // Whack-a-Mole: a new letter if nobody keys this one in time
const MOLE_PAUSE_MS = 1200;    // pause after a hit before the next mole
const MODES = ['race', 'team', 'whack', 'chat'];

class Room {
  constructor(send) {
    this.send = send;
    this.mode = 'race';
    this.players = new Map();   // pid -> player
    this.tapes = new Map();     // pid -> [item]
    this.nextItem = 1;
    this.pending = [];          // [{pid, ch, at}]
    this.challenge = false;     // Team mode: keyers get random letters to key
    this.keyerRule = 'anyone';  // Team mode: 'anyone' | 'rr1' | 'rrN' (take turns)
    this.turnN = 5;             // letters per turn for 'rrN'
    this.turn = null;           // { pid, left }
    this.mole = null;           // Whack-a-Mole: { id, ch, at }
    this.moleTimer = 0;
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
    if (item.team) {
      v.team = true;
      v.guessed = item.guesses.size;
      v.eligible = item.eligible.size;
      if (item.state === 'open' && item.guesses.has(viewer)) v.myGuess = item.guesses.get(viewer);
      if (item.state === 'done') {
        v.correct = item.correct;
        v.keyerScored = item.keyerScored;
        if (item.target) v.target = item.target;
      }
    }
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
      t: 'welcome', you: viewer, mode: this.mode, challenge: this.challenge,
      keyerRule: this.keyerRule, turnN: this.turnN, turn: this.turnInfo(),
      mole: this.mole ? { id: this.mole.id, ch: this.mole.ch } : null,
      target: (this.players.get(viewer) || {}).target || null,
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
    if (this.challengeOn() && !p.target) p.target = this.randomLetter(p.target);
    if (this.turnsOn() && !this.turn) this.startTurns(null);
    this.send(pid, this.snapshot(pid));
    this.sendPlayers();
  }

  leave(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    p.online = false;
    p.keying = false;
    this.sendPlayers();
    if (this.turn && this.turn.pid === pid) this.startTurns(pid);
    // Don't keep a Team letter waiting for someone who left.
    for (const { owner, it } of this.openItems()) {
      if (!it.team) continue;
      const waiting = [...it.eligible].some(q => !it.guesses.has(q) && (this.players.get(q) || {}).online);
      if (!waiting) this.closeTeam(owner, it);
    }
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
        if (!this.mayKey(p)) return;
        p.keying = true;
        p.keyingAt = Date.now();
        return this.broadcast({ t: msg.t, pid, kt: +msg.kt, sym: msg.sym === '-' ? '-' : '.' }, pid);

      case 'letter':
        if (!this.mayKey(p)) return;
        return this.onLetter(p, String(msg.code || ''), msg.ch ? String(msg.ch) : null);
      case 'space':  return this.onSpace(p);
      case 'guess':  return this.onGuess(p, String(msg.ch || '').toUpperCase().slice(0, 1));
      case 'type':   return this.onType(p, String(msg.ch || '').slice(0, 1));
      case 'backspace': return this.onBackspace(p);

      case 'mode':
        if (!MODES.includes(msg.mode)) return;
        this.mode = msg.mode;
        this.revealAllOpen();
        this.broadcast({ t: 'mode', mode: this.mode, by: p.name });
        this.refreshTargets();
        this.startTurns(null);
        if (this.mode === 'whack') this.newMole();
        else if (this.mole || this.moleTimer) this.stopMole();
        return;
      case 'setKeyers':
        if (!['anyone', 'rr1', 'rrN'].includes(msg.rule)) return;
        this.keyerRule = msg.rule;
        this.turnN = Math.min(50, Math.max(1, Math.round(+msg.n || this.turnN)));
        this.broadcast({ t: 'keyers', rule: this.keyerRule, n: this.turnN, by: p.name });
        return this.startTurns(null);
      case 'pass':
        if (this.turn && this.turn.pid === p.pid) this.startTurns(p.pid);
        return;
      case 'skipMole':
        if (this.mode === 'whack') this.newMole(this.mole && this.mole.ch);
        return;
      case 'setChallenge':
        this.challenge = !!msg.on;
        this.broadcast({ t: 'challengeMode', on: this.challenge, by: p.name });
        return this.refreshTargets();
      case 'skip':
        if (!this.challengeOn()) return;
        p.target = this.randomLetter(p.target);
        return this.send(p.pid, { t: 'target', ch: p.target });
      case 'clear':
        for (const { it } of this.openItems()) { clearTimeout(it.timer); it.state = 'cleared'; }
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
    if (this.mode === 'whack') return this.onWhackLetter(p, code, ch);
    if (this.mode === 'team') {
      this.onTeamLetter(p, code, ch);
      if (this.turnsOn() && this.turn && this.turn.pid === p.pid) {
        this.turn.left--;
        if (this.turn.left <= 0) this.startTurns(p.pid);
        else this.sendTurn();
      }
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
    if (this.mode === 'team' && ch) return this.onTeamGuess(p, ch);
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
      if (it.team) { this.closeTeam(owner, it); continue; }
      clearTimeout(it.timer);
      it.state = 'missed';
      this.sendItem(owner, it);
    }
  }

  // ---------- Team mode: taking turns ----------
  turnsOn() { return this.mode === 'team' && this.keyerRule !== 'anyone'; }
  lettersPerTurn() { return this.keyerRule === 'rr1' ? 1 : this.turnN; }
  turnInfo() {
    return this.turnsOn() && this.turn ? { pid: this.turn.pid, left: this.turn.left, per: this.lettersPerTurn() } : null;
  }
  sendTurn() { this.broadcast({ t: 'turn', turn: this.turnInfo() }); }
  mayKey(p) { return !this.turnsOn() || !this.turn || this.turn.pid === p.pid; }

  // Give the key to the next online player after `afterPid` (join order),
  // or to the first online player when `afterPid` is null.
  startTurns(afterPid) {
    if (!this.turnsOn()) { this.turn = null; return this.sendTurn(); }
    const all = [...this.players.keys()];
    const start = afterPid ? all.indexOf(afterPid) + 1 : 0;
    const rotated = all.slice(start).concat(all.slice(0, start));
    const next = rotated.find(q => this.players.get(q).online);
    this.turn = next ? { pid: next, left: this.lettersPerTurn() } : null;
    this.sendTurn();
  }

  // ---------- Whack-a-Mole ----------
  // A random letter pops up for everyone; the first to key it scores.
  newMole(prev) {
    clearTimeout(this.moleTimer);
    const ch = this.randomLetter(prev);
    this.mole = { id: this.nextItem++, ch, at: Date.now() };
    this.broadcast({ t: 'mole', mole: { id: this.mole.id, ch } });
    this.moleTimer = setTimeout(() => this.newMole(ch), MOLE_MS);
  }

  stopMole() {
    clearTimeout(this.moleTimer);
    this.moleTimer = 0;
    this.mole = null;
    this.broadcast({ t: 'mole', mole: null });
  }

  onWhackLetter(p, code, ch) {
    const m = this.mole;
    const hit = !!m && ch === m.ch;
    this.addItem(p.pid, { ch, code, state: hit ? 'hit' : 'sent' });
    if (!hit) return;
    clearTimeout(this.moleTimer);
    p.score++;
    this.mole = null;
    this.broadcast({ t: 'whacked', by: p.pid, ch, ms: Date.now() - m.at });
    this.sendPlayers();
    this.moleTimer = setTimeout(() => this.newMole(ch), MOLE_PAUSE_MS);
  }

  // ---------- Team mode ----------
  // Everyone but the keyer gets one guess per letter. Right first guesses
  // score 1; the keyer scores 1 if at least one guesser got it (and, in
  // Challenge, only if they keyed the letter they were asked to).
  challengeOn() { return this.mode === 'team' && this.challenge; }

  randomLetter(not) {
    let ch;
    do ch = CHALLENGE_LETTERS[Math.floor(Math.random() * CHALLENGE_LETTERS.length)];
    while (ch === not);
    return ch;
  }

  refreshTargets() {
    for (const p of this.online()) {
      const want = this.challengeOn();
      if (want && !p.target) p.target = this.randomLetter();
      if (!want) p.target = null;
      this.send(p.pid, { t: 'target', ch: p.target || null });
    }
  }

  onTeamLetter(p, code, ch) {
    const eligible = new Set(this.online().filter(o => o.pid !== p.pid).map(o => o.pid));
    const fields = { ch, code, state: 'open', team: true, guesses: new Map(), eligible };
    if (this.challengeOn() && p.target) {
      fields.target = p.target;
      p.target = this.randomLetter(p.target);
    }
    const item = this.addItem(p.pid, fields);
    item.timer = setTimeout(() => this.closeTeam(p.pid, item), TEAM_REVEAL_MS);
    if (fields.target) this.send(p.pid, { t: 'target', ch: p.target });

    // Guesses typed while this letter was still being keyed.
    const now = Date.now();
    const early = this.pending.filter(g => now - g.at < PENDING_MS && g.pid !== p.pid && eligible.has(g.pid));
    this.pending = this.pending.filter(g => !early.includes(g));
    for (const g of early) if (!item.guesses.has(g.pid)) this.recordTeamGuess(this.players.get(g.pid), p.pid, item, g.ch);
  }

  onTeamGuess(p, ch) {
    const now = Date.now();
    const open = this.openItems().filter(o => o.it.team && o.owner !== p.pid && o.it.eligible.has(p.pid) && !o.it.guesses.has(p.pid));
    if (open.length) return this.recordTeamGuess(p, open[0].owner, open[0].it, ch);
    const someoneKeying = this.online().some(o => o.pid !== p.pid && o.keying && now - o.keyingAt < 5000);
    if (someoneKeying && !this.pending.some(g => g.pid === p.pid)) {
      this.pending.push({ pid: p.pid, ch, at: now });
      return this.send(p.pid, { t: 'guess', ch, result: 'pending' });
    }
    this.send(p.pid, { t: 'guess', ch, result: 'nothing' });
  }

  recordTeamGuess(p, owner, item, ch) {
    const ok = ch === item.ch;
    item.guesses.set(p.pid, ch);
    this.send(p.pid, { t: 'guess', ch, result: ok ? 'right' : 'wrong', team: true });
    const allIn = [...item.eligible].every(pid => item.guesses.has(pid) || !(this.players.get(pid) || {}).online);
    if (allIn) this.closeTeam(owner, item);
    else this.sendItem(owner, item);
  }

  closeTeam(owner, item) {
    if (item.state !== 'open') return;
    clearTimeout(item.timer);
    item.state = 'done';
    item.correct = [...item.guesses].filter(([, g]) => g === item.ch).map(([pid]) => pid);
    const keyedRight = !item.target || item.target === item.ch;
    item.keyerScored = item.correct.length > 0 && keyedRight;
    for (const pid of item.correct) { const q = this.players.get(pid); if (q) q.score++; }
    if (item.keyerScored) { const k = this.players.get(owner); if (k) k.score++; }
    this.sendItem(owner, item);
    this.sendPlayers();
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
