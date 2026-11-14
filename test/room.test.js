// Run: node test/room.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = { console, setTimeout, clearTimeout, Date };
vm.createContext(ctx);
for (const f of ['js/morse.js', 'js/room.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8') + '\n;this.Room = typeof Room !== "undefined" ? Room : this.Room; this.VOICES = typeof VOICES !== "undefined" ? VOICES : this.VOICES; this.MORSE_CHAR_TO_CODE = MORSE_CHAR_TO_CODE;', ctx);

function setup() {
  const inbox = {};
  const room = new ctx.Room((pid, msg) => (inbox[pid] = inbox[pid] || []).push(msg));
  const last = (pid, t) => (inbox[pid] || []).filter(m => m.t === t).pop();
  for (const [pid, name] of [['k', 'Keyer'], ['a', 'Alice'], ['b', 'Bob']]) room.handle(pid, { t: 'hello', name, wpm: 15 });
  return { room, inbox, last };
}
let n = 0; const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('players get distinct voices and a welcome', () => {
  const { room, last } = setup();
  const v = [...room.players.values()].map(p => p.voice);
  assert.strictEqual(new Set(v).size, 3);
  assert.strictEqual(last('a', 'welcome').you, 'a');
});

test('open letters hide the answer from everyone but the keyer', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '-.-.', ch: 'C' });
  assert.strictEqual(last('a', 'item').item.ch, undefined);
  assert.strictEqual(last('k', 'item').item.ch, 'C');
  assert.strictEqual(last('a', 'play').code, '-.-.');
});

test('first correct guess wins and scores', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '-.-.', ch: 'C' });
  room.handle('b', { t: 'guess', ch: 'c' });
  room.handle('a', { t: 'guess', ch: 'C' });
  assert.strictEqual(last('b', 'guess').result, 'right');
  assert.strictEqual(last('a', 'guess').result, 'nothing');
  assert.strictEqual(room.players.get('b').score, 1);
  const it = last('a', 'item').item;
  assert.strictEqual(it.state, 'won'); assert.strictEqual(it.ch, 'C'); assert.strictEqual(it.by, 'b');
});

test('wrong guess locks out for a second', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '.-', ch: 'A' });
  room.handle('a', { t: 'guess', ch: 'E' });
  assert.strictEqual(last('a', 'guess').result, 'wrong');
  room.handle('a', { t: 'guess', ch: 'A' });
  assert.strictEqual(last('a', 'guess').result, 'locked');
  room.players.get('a').lockUntil = 0;
  room.handle('a', { t: 'guess', ch: 'A' });
  assert.strictEqual(last('a', 'guess').result, 'right');
});

test('keyer cannot win their own letter', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  room.handle('k', { t: 'guess', ch: 'E' });
  assert.notStrictEqual(last('k', 'guess').result, 'right');
});

test('a guess typed while the letter is still being keyed is held, then wins', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'down', kt: 1 }); room.handle('k', { t: 'up', kt: 100, sym: '-' });
  room.handle('a', { t: 'guess', ch: 'T' });
  assert.strictEqual(last('a', 'guess').result, 'pending');
  room.handle('k', { t: 'letter', code: '-', ch: 'T' });
  assert.strictEqual(last('a', 'guess').result, 'right');
  assert.strictEqual(room.players.get('a').score, 1);
});

test('the server decodes, not the client', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '...', ch: 'Z' });
  room.handle('a', { t: 'guess', ch: 'S' });
  assert.strictEqual(last('a', 'guess').result, 'right');
});

test('chat mode: keyed and typed letters go straight onto the tape; backspace removes typed', () => {
  const { room, last } = setup();
  room.handle('a', { t: 'mode', mode: 'chat' });
  assert.strictEqual(last('b', 'mode').mode, 'chat');
  room.handle('k', { t: 'letter', code: '....', ch: 'H' });
  assert.strictEqual(last('a', 'item').item.ch, 'H');
  assert.strictEqual(last('a', 'item').item.state, 'sent');
  room.handle('a', { t: 'type', ch: 'h' });
  room.handle('a', { t: 'type', ch: 'i' });
  assert.strictEqual(last('k', 'item').item.ch, 'I');
  assert.strictEqual(last('k', 'play').kind, 'typed');
  room.handle('a', { t: 'backspace' });
  assert.strictEqual(last('k', 'remove').pid, 'a');
  assert.strictEqual(room.tapes.get('a').map(i => i.ch).join(''), 'H');
  room.handle('a', { t: 'guess', ch: 'H' });
  assert.strictEqual(last('a', 'guess'), undefined);
});

test('switching to chat reveals open letters', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '.-', ch: 'A' });
  room.handle('b', { t: 'mode', mode: 'chat' });
  assert.strictEqual(room.tapes.get('k')[0].state, 'missed');
});

test('invalid code is marked bad and not guessable', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'letter', code: '........', ch: null });
  assert.strictEqual(last('a', 'item').item.state, 'bad');
});

test('reconnecting keeps score and tape; offline players free their voice', () => {
  const { room } = setup();
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  room.handle('a', { t: 'guess', ch: 'E' });
  room.leave('a');
  assert.strictEqual(room.players.get('a').online, false);
  room.handle('a', { t: 'hello', name: 'Alice', wpm: 15 });
  assert.strictEqual(room.players.get('a').score, 1);
});

// ---------- Team mode ----------
const MORSE_CODE = ch => ctx.MORSE_CHAR_TO_CODE[ch];
function team(challenge) {
  const env = setup();
  env.room.handle('d', { t: 'hello', name: 'Dee', wpm: 15 });
  env.room.handle('k', { t: 'mode', mode: 'team' });
  if (challenge) env.room.handle('k', { t: 'setChallenge', on: true });
  return env;
}
const scores = room => Object.fromEntries([...room.players.values()].map(p => [p.pid, p.score]));

test('team: right first guesses score, keyer scores, wrong guesser does not', () => {
  const { room, last } = team();
  room.handle('k', { t: 'letter', code: '-.-', ch: 'K' });
  room.handle('a', { t: 'guess', ch: 'K' });
  assert.strictEqual(last('a', 'guess').result, 'right');
  assert.strictEqual(last('b', 'item').item.state, 'open');
  assert.strictEqual(last('b', 'item').item.guessed, 1);
  room.handle('b', { t: 'guess', ch: 'R' });
  assert.strictEqual(last('b', 'guess').result, 'wrong');
  room.handle('d', { t: 'guess', ch: 'K' });
  const it = last('a', 'item').item;
  assert.strictEqual(it.state, 'done');
  assert.deepStrictEqual([...it.correct].sort(), ['a', 'd']);
  assert.deepStrictEqual(scores(room), { k: 1, a: 1, b: 0, d: 1 });
});

test('team: only the first guess counts', () => {
  const { room, last } = team();
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  room.handle('a', { t: 'guess', ch: 'T' });
  room.handle('a', { t: 'guess', ch: 'E' });
  assert.strictEqual(last('a', 'guess').result, 'nothing');
  assert.strictEqual(room.players.get('a').score, 0);
});

test('team: keyer gets nothing if nobody gets it', () => {
  const { room } = team();
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  for (const g of ['a', 'b', 'd']) room.handle(g, { t: 'guess', ch: 'I' });
  assert.deepStrictEqual(scores(room), { k: 0, a: 0, b: 0, d: 0 });
  assert.strictEqual(room.tapes.get('k')[0].state, 'done');
});

test('team: a guesser leaving does not keep the letter open', () => {
  const { room } = team();
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  room.handle('a', { t: 'guess', ch: 'E' });
  room.handle('b', { t: 'guess', ch: 'E' });
  room.leave('d');
  assert.strictEqual(room.tapes.get('k')[0].state, 'done');
  assert.strictEqual(room.players.get('k').score, 1);
});

test('team: early guess counts once the letter is finished', () => {
  const { room, last } = team();
  room.handle('k', { t: 'down', kt: 1 });
  room.handle('a', { t: 'guess', ch: 'T' });
  assert.strictEqual(last('a', 'guess').result, 'pending');
  room.handle('k', { t: 'letter', code: '-', ch: 'T' });
  assert.strictEqual(last('a', 'guess').result, 'right');
});

test('challenge: everyone gets a private target; keying it right lets the keyer score', () => {
  const { room, last } = team(true);
  const target = last('k', 'target').ch;
  assert.match(target, /^[A-Z]$/);
  room.handle('k', { t: 'letter', code: MORSE_CODE(target), ch: target });
  assert.notStrictEqual(last('k', 'target').ch, target);
  for (const g of ['a', 'b', 'd']) room.handle(g, { t: 'guess', ch: target });
  assert.deepStrictEqual(scores(room), { k: 1, a: 1, b: 1, d: 1 });
});

test('challenge: keying the wrong letter - guessers judged on what they heard, keyer gets nothing', () => {
  const { room, last } = team(true);
  const target = last('k', 'target').ch;
  const other = target === 'E' ? 'T' : 'E';
  room.handle('k', { t: 'letter', code: MORSE_CODE(other), ch: other });
  for (const g of ['a', 'b', 'd']) room.handle(g, { t: 'guess', ch: other });
  assert.deepStrictEqual(scores(room), { k: 0, a: 1, b: 1, d: 1 });
  assert.strictEqual(last('a', 'item').item.target, target);
});

test('challenge: skip gives a new letter; leaving team mode clears targets', () => {
  const { room, last } = team(true);
  const t1 = last('a', 'target').ch;
  room.handle('a', { t: 'skip' });
  assert.notStrictEqual(last('a', 'target').ch, t1);
  room.handle('a', { t: 'mode', mode: 'race' });
  assert.strictEqual(last('a', 'target').ch, null);
});


// ---------- Taking turns (Team) ----------
test('turns, 1 letter each: only the current keyer can key, then it rotates', () => {
  const { room, last } = team();
  room.handle('a', { t: 'setKeyers', rule: 'rr1' });
  assert.strictEqual(last('b', 'turn').turn.pid, 'k');            // join order: k, a, b, d
  room.handle('a', { t: 'letter', code: '.', ch: 'E' });          // not a's turn: ignored
  assert.strictEqual((room.tapes.get('a') || []).length, 0);
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  assert.strictEqual(last('b', 'turn').turn.pid, 'a');
  room.handle('a', { t: 'down', kt: 1 });
  assert.strictEqual(last('k', 'down').pid, 'a');
});

test('turns, N letters each: I do 3, you do 3; bad letters do not count', () => {
  const { room, last } = team();
  room.handle('k', { t: 'setKeyers', rule: 'rrN', n: 3 });
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  room.handle('k', { t: 'letter', code: '........', ch: null });
  assert.strictEqual(last('a', 'turn').turn.left, 2);
  room.handle('k', { t: 'letter', code: '-', ch: 'T' });
  room.handle('k', { t: 'letter', code: '..', ch: 'I' });
  assert.deepStrictEqual({ ...last('a', 'turn').turn }, { pid: 'a', left: 3, per: 3 });
});

test('turns skip players who left, and pass works', () => {
  const { room, last } = team();
  room.handle('k', { t: 'setKeyers', rule: 'rr1' });
  room.leave('a');
  room.handle('k', { t: 'letter', code: '.', ch: 'E' });
  assert.strictEqual(last('b', 'turn').turn.pid, 'b');
  room.handle('b', { t: 'pass' });
  assert.strictEqual(last('b', 'turn').turn.pid, 'd');
  room.leave('d');
  assert.strictEqual(last('b', 'turn').turn.pid, 'k');
});

test('turns end when leaving Team mode', () => {
  const { room, last } = team();
  room.handle('k', { t: 'setKeyers', rule: 'rr1' });
  room.handle('k', { t: 'mode', mode: 'race' });
  assert.strictEqual(last('a', 'turn').turn, null);
  room.handle('a', { t: 'letter', code: '.', ch: 'E' });
  assert.strictEqual(room.tapes.get('a').length, 1);
});

// ---------- Whack-a-Mole ----------
test('whack: first to key the mole scores; wrong letters just go on the tape', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'mode', mode: 'whack' });
  const mole = last('a', 'mole').mole.ch;
  const wrong = mole === 'E' ? 'T' : 'E';
  room.handle('a', { t: 'letter', code: MORSE_CODE(wrong), ch: wrong });
  assert.strictEqual(room.players.get('a').score, 0);
  room.handle('b', { t: 'letter', code: MORSE_CODE(mole), ch: mole });
  assert.strictEqual(last('k', 'whacked').by, 'b');
  assert.strictEqual(room.players.get('b').score, 1);
  assert.strictEqual(room.tapes.get('b')[0].state, 'hit');
  room.handle('a', { t: 'letter', code: MORSE_CODE(mole), ch: mole }); // too late
  assert.strictEqual(room.players.get('a').score, 0);
  room.handle('a', { t: 'guess', ch: mole });                         // typing does nothing here
  assert.strictEqual(last('a', 'guess'), undefined);
  room.handle('k', { t: 'mode', mode: 'chat' });
  assert.strictEqual(last('a', 'mole').mole, null);
});

test('whack: skip gives a different letter', () => {
  const { room, last } = setup();
  room.handle('k', { t: 'mode', mode: 'whack' });
  const m1 = last('a', 'mole').mole.ch;
  room.handle('a', { t: 'skipMole' });
  assert.notStrictEqual(last('a', 'mole').mole.ch, m1);
  room.handle('k', { t: 'mode', mode: 'race' });
});


console.log(`\n${n} tests passed`);
process.exit(0);
