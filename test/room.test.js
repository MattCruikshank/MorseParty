// Run: node test/room.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = { console, setTimeout, clearTimeout, Date };
vm.createContext(ctx);
for (const f of ['js/morse.js', 'js/room.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8') + '\n;this.Room = typeof Room !== "undefined" ? Room : this.Room; this.VOICES = typeof VOICES !== "undefined" ? VOICES : this.VOICES;', ctx);

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

console.log(`\n${n} tests passed`);
process.exit(0);
