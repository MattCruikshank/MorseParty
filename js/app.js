(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ======================================================================
  // Settings (per browser)
  // ======================================================================
  const DEFAULTS = {
    name: '', wpm: 12,
    showCard: true, hearSelf: true,
    hearOthers: true, toneStyle: 'live', showMarks: true, playTyped: false, volume: 0.5,
  };
  const S = (() => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('morseparty.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  })();
  const save = () => { try { localStorage.setItem('morseparty.settings', JSON.stringify(S)); } catch (e) { /* ignore */ } };

  // Player id: one per tab (survives a reload). `?pid=` overrides, for testing.
  const params = new URLSearchParams(location.search);
  const ME = params.get('pid') || (() => {
    let id = null;
    try { id = sessionStorage.getItem('morseparty.pid'); } catch (e) { /* ignore */ }
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 12);
      try { sessionStorage.setItem('morseparty.pid', id); } catch (e) { /* ignore */ }
    }
    return id;
  })();

  // Every prefix of every Morse code, for spotting impossible keying early.
  const PREFIXES = new Set();
  for (const code of Object.keys(MORSE_CODE_TO_CHAR)) for (let i = 1; i <= code.length; i++) PREFIXES.add(code.slice(0, i));

  // ======================================================================
  // State
  // ======================================================================
  let net = null, isHost = false, roomCode = '';
  let mode = 'race';
  let challenge = false, target = null;
  let keyerRule = 'anyone', turnN = 5, turn = null, mole = null;
  let players = new Map();     // pid -> {pid, name, voice, score, online, wpm}
  let order = [];              // pids in join order
  let tapes = new Map();       // pid -> [item]
  const live = new Map();      // pid -> {code, down, at}   (dots/dashes in progress)

  const MODE_NAMES = { race: 'Race', team: 'Team', whack: 'Whack-a-Mole', chat: 'Chat' };
  const KEYER_RULES = { anyone: 'anyone keys', rr1: 'take turns, 1 letter each', rrN: 'take turns, N letters each' };
  const MODE_HELP = {
    race: 'Anyone can key. Everyone else types the letter they hear. First right answer scores; a wrong guess locks you out for a second.',
    team: 'Anyone can key. Everyone else gets one guess per letter. Everyone who gets it right scores, and so does the keyer if anyone got it.',
    whack: 'A letter pops up for everyone. The first person to key it correctly gets the point.',
    chat: 'No right answers. Key or type, and everything you send goes on your own tape.',
  };
  const voiceOf = pid => VOICES[(players.get(pid) || {}).voice || 0] || VOICES[0];
  const nameOf = pid => (players.get(pid) || {}).name || '?';
  const send = msg => net && net.send(msg);

  // ======================================================================
  // Lobby
  // ======================================================================
  const nameInput = $('#nameInput'), codeInput = $('#codeInput'), lobbyMsg = $('#lobbyMsg');
  nameInput.value = S.name;
  if (params.get('room')) codeInput.value = Net.cleanCode(params.get('room'));

  function needName() {
    const n = nameInput.value.trim();
    if (!n) { lobbyMsg.textContent = 'Pick a nickname first.'; lobbyMsg.className = 'status err'; nameInput.focus(); return null; }
    S.name = n.slice(0, 24); save();
    return S.name;
  }

  $('#createBtn').addEventListener('click', async () => {
    if (!needName()) return;
    Sound.ensure();
    lobbyMsg.className = 'status'; lobbyMsg.textContent = 'Creating room…';
    try {
      net = await Net.host({ pid: ME, onMessage, onStatus: hostStatus });
      isHost = true;
      roomCode = net.code;
      enterRoom();
      setConn('open');
      send({ t: 'hello', pid: ME, name: S.name, wpm: S.wpm });
    } catch (err) {
      lobbyMsg.className = 'status err';
      lobbyMsg.textContent = `Couldn't create a room (${err.type || err.message || err}). Check your connection and try again.`;
    }
  });

  function join() {
    if (!needName()) return;
    const code = Net.cleanCode(codeInput.value);
    if (!code) { lobbyMsg.textContent = 'Enter the room code.'; lobbyMsg.className = 'status err'; codeInput.focus(); return; }
    Sound.ensure();
    roomCode = code;
    isHost = false;
    net = Net.join({ code, onMessage, onStatus: guestStatus });
    enterRoom();
  }
  $('#joinBtn').addEventListener('click', join);
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') (codeInput.value ? join() : $('#createBtn').click()); });

  function enterRoom() {
    $('#lobby').hidden = true;
    $('#room').hidden = false;
    $('#roomInfo').hidden = false;
    $('#roomCode').textContent = roomCode;
    renderCardVisibility();
    renderAll();
  }

  function inviteLink() {
    return location.origin + location.pathname + '?room=' + roomCode;
  }
  $('#copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied'); }
    catch (e) { prompt('Copy this link:', inviteLink()); }
  });

  $('#leaveBtn').addEventListener('click', () => {
    if (isHost && !confirm('You are hosting. Leaving ends the room for everyone. Leave?')) return;
    net && net.close();
    location.href = location.pathname;
  });
  window.addEventListener('beforeunload', e => {
    if (isHost && players.size > 1) { e.preventDefault(); e.returnValue = ''; }
  });

  // ======================================================================
  // Connection status
  // ======================================================================
  function setConn(state, text) {
    const el = $('#conn');
    el.className = 'conn ' + state;
    el.title = text || state;
  }
  function hostStatus(state, err) {
    if (state === 'error') toast(`Connection problem: ${err && err.type || err}`, 'err');
  }
  function guestStatus(state) {
    if (state === 'open') {
      setConn('open', 'Connected');
      send({ t: 'hello', pid: ME, name: S.name, wpm: S.wpm });
    } else if (state === 'connecting') setConn('wait', 'Connecting…');
    else if (state === 'nohost') { setConn('err', 'Room not found'); showBanner(`Waiting for room ${roomCode}… (is the host's tab open?)`); }
    else if (state === 'lost') { setConn('err', 'Reconnecting…'); showBanner('Lost the connection to the host. Reconnecting…'); }
    else if (state === 'error') setConn('err', 'Error');
  }
  function showBanner(text) {
    if (players.size === 0) $('#tapes').innerHTML = `<p class="empty">${esc(text)}</p>`;
    else toast(text, 'err');
  }

  // ======================================================================
  // Messages from the room
  // ======================================================================
  function onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        mode = msg.mode;
        challenge = !!msg.challenge;
        target = msg.target || null;
        keyerRule = msg.keyerRule || 'anyone';
        turnN = msg.turnN || 5;
        turn = msg.turn || null;
        mole = msg.mole || null;
        setPlayers(msg.players);
        tapes = new Map(Object.entries(msg.tapes));
        renderAll();
        break;
      case 'players':
        setPlayers(msg.players);
        renderPlayers();
        renderTapes();
        break;
      case 'item': onItem(msg.pid, msg.item, msg.isNew); break;
      case 'remove': {
        const t = tapes.get(msg.pid);
        if (t) { const i = t.findIndex(x => x.id === msg.id); if (i >= 0) t.splice(i, 1); }
        renderTape(msg.pid);
        break;
      }
      case 'tapes':
        tapes = new Map(Object.entries(msg.tapes));
        live.clear();
        renderTapes();
        toast(`${msg.by} cleared the tapes`);
        break;
      case 'mode':
        mode = msg.mode;
        renderMode();
        toast(`${msg.by} switched to ${MODE_NAMES[mode]}`);
        break;
      case 'challengeMode':
        challenge = !!msg.on;
        renderMode();
        toast(`${msg.by} switched to ${challenge ? 'Challenge' : 'Free play'}`);
        break;
      case 'keyers':
        keyerRule = msg.rule;
        turnN = msg.n;
        renderMode();
        toast(`${msg.by}: ${KEYER_RULES[keyerRule].replace('N', turnN)}`);
        break;
      case 'turn': {
        const was = turn && turn.pid;
        turn = msg.turn;
        renderTurn();
        if (turn && turn.pid === ME && was !== ME) toast('Your turn to key!', 'ok');
        break;
      }
      case 'mole':
        mole = msg.mole;
        renderMole(true);
        break;
      case 'whacked': {
        const who = msg.by === ME ? 'You' : nameOf(msg.by);
        toast(`${esc(who)} whacked <b>${esc(msg.ch)}</b> in ${(msg.ms / 1000).toFixed(1)} s`, msg.by === ME ? 'ok' : '');
        mole = null;
        renderMole(false, msg.by);
        renderPlayers();
        break;
      }
      case 'target':
        target = msg.ch || null;
        renderTarget();
        break;
      case 'down': onRemoteKey(msg.pid, true, msg.kt); break;
      case 'up': onRemoteKey(msg.pid, false, msg.kt, msg.sym); break;
      case 'play':
        if (!S.hearOthers) break;
        if (msg.kind === 'key' && S.toneStyle === 'clean') Sound.playCode(msg.pid, voiceOf(msg.pid), msg.code, msg.wpm);
        if (msg.kind === 'typed' && S.playTyped) Sound.playCode(msg.pid, voiceOf(msg.pid), msg.code, msg.wpm);
        break;
      case 'guess': onGuessResult(msg); break;
    }
  }

  function setPlayers(list) {
    for (const p of list) {
      if (!players.has(p.pid)) order.push(p.pid);
      players.set(p.pid, p);
    }
  }

  function onItem(pid, item, isNew) {
    if (!tapes.has(pid)) tapes.set(pid, []);
    const t = tapes.get(pid);
    const i = t.findIndex(x => x.id === item.id);
    const before = i >= 0 ? t[i] : null;
    if (i >= 0) t[i] = item; else t.push(item);
    if (isNew && !item.typed && pid !== ME) live.delete(pid);
    renderTape(pid);
    if (before && before.state === 'open' && item.state === 'won') {
      const who = item.by === ME ? 'You' : nameOf(item.by);
      toast(`${who} got <b>${esc(item.ch)}</b> in ${(item.ms / 1000).toFixed(2)} s`, item.by === ME ? 'ok' : '');
      flashCell(pid, item.id);
      renderPlayers();
    }
    if (before && before.state === 'open' && item.state === 'done') teamToast(pid, item);
  }

  function teamToast(pid, it) {
    const names = it.correct.map(q => (q === ME ? 'you' : nameOf(q)));
    const keyer = pid === ME ? 'you' : nameOf(pid);
    let text;
    if (!names.length) text = `Nobody got <b>${esc(it.ch)}</b>`;
    else text = `<b>${esc(it.ch)}</b>: ${esc(names.join(', '))} got it` + (it.keyerScored ? ` · ${esc(keyer)} +1 for keying` : '');
    if (it.target && it.target !== it.ch) text += ` · ${esc(keyer)} was meant to key <b>${esc(it.target)}</b>`;
    toast(text, it.correct.includes(ME) || (pid === ME && it.keyerScored) ? 'ok' : '');
    flashCell(pid, it.id);
  }

  function onRemoteKey(pid, down, kt, sym) {
    if (S.hearOthers && S.toneStyle === 'live') {
      if (down) Sound.remoteDown(pid, voiceOf(pid), kt);
      else Sound.remoteUp(pid, kt);
    }
    const l = live.get(pid) || { code: '' };
    l.down = down;
    l.at = Date.now();
    if (!down) l.code += sym;
    live.set(pid, l);
    renderLive(pid);
  }

  // Forget stale in-progress letters (e.g. the keyer's tab went away).
  setInterval(() => {
    const now = Date.now();
    for (const [pid, l] of live) if (now - l.at > 4000) { live.delete(pid); renderLive(pid); }
  }, 1000);

  // ======================================================================
  // Rendering
  // ======================================================================
  function renderAll() {
    renderMode();
    renderPlayers();
    renderTapes();
  }

  function renderMode() {
    document.querySelectorAll('.mode button').forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    const scored = mode !== 'chat';
    $('#guessPanel').hidden = mode !== 'race' && mode !== 'team';
    $('#chatPanel').hidden = mode !== 'chat';
    $('#resetBtn').hidden = !scored;
    $('#challengeSeg').hidden = mode !== 'team';
    $('#keyerRuleBox').hidden = mode !== 'team';
    $('#keyerRule').value = keyerRule;
    $('#turnN').value = turnN;
    $('#turnNBox').hidden = keyerRule !== 'rrN';
    document.querySelectorAll('#challengeSeg button').forEach(b => {
      const on = (b.dataset.challenge === '1') === challenge;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    $('#guessLabel').textContent = mode === 'team' ? 'Type the letter you hear (one guess per letter)' : 'Type the letter you hear';
    $('#modeHelp').textContent = MODE_HELP[mode] + (mode === 'team' && challenge
      ? ' Challenge: everyone gets a random letter to key, and the keyer only scores if they key it right.' : '');
    document.body.dataset.mode = mode;
    renderPlayers();
    renderTurn();
    renderMole(false);
  }

  const myTurn = () => !turn || turn.pid === ME;

  function renderTarget() {
    $('#targetPanel').hidden = !(mode === 'team' && challenge && target && myTurn());
    $('#targetCh').textContent = target || '';
  }

  function renderTurn() {
    const on = mode === 'team' && !!turn;
    $('#turnPanel').hidden = !on;
    document.body.classList.toggle('not-my-turn', on && turn.pid !== ME);
    if (on) {
      const left = turn.per > 1 ? ` (${turn.left} of ${turn.per} letters left)` : '';
      $('#turnText').innerHTML = turn.pid === ME
        ? `<b>Your turn to key</b>${left}`
        : `<b>${esc(nameOf(turn.pid))}</b> is keying${left}. Listen and guess!`;
      $('#turnPanel').classList.toggle('mine', turn.pid === ME);
      $('#passBtn').hidden = turn.pid !== ME;
    }
    renderTarget();
    renderPlayers();
  }

  function renderMole(popped, winner) {
    $('#molePanel').hidden = mode !== 'whack';
    const el = $('#moleCh');
    if (mole) {
      el.textContent = mole.ch;
      el.className = 'mole up';
      if (popped) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
      $('#moleText').textContent = 'First to key it wins!';
    } else {
      el.className = 'mole down';
      $('#moleText').textContent = winner ? `${winner === ME ? 'You' : nameOf(winner)} got it! Next one coming…` : 'Get ready…';
    }
  }

  function renderPlayers() {
    const box = $('#players');
    box.innerHTML = order.map(pid => {
      const p = players.get(pid);
      if (!p) return '';
      const v = VOICES[p.voice] || VOICES[0];
      const l = live.get(pid);
      const turnCls = mode === 'team' && turn && turn.pid === pid ? ' has-key' : '';
      return `<div class="player${p.online ? '' : ' offline'}${l && (l.down || l.code) ? ' keying' : ''}${turnCls}" data-pid="${esc(pid)}">
        <span class="swatch" style="--c:${v.color}"></span>
        <span class="pname">${esc(p.name)}${pid === ME ? ' <small>(you)</small>' : ''}</span>
        ${mode !== 'chat' ? `<span class="score">${p.score}</span>` : ''}
      </div>`;
    }).join('');
  }

  function renderTapes() {
    const box = $('#tapes');
    const rows = order.filter(pid => {
      const p = players.get(pid);
      return p && (p.online || (tapes.get(pid) || []).length);
    });
    if (!rows.length) { box.innerHTML = '<p class="empty">Connecting…</p>'; return; }
    box.innerHTML = rows.map(pid => {
      const p = players.get(pid), v = VOICES[p.voice] || VOICES[0];
      return `<div class="tape-row" data-pid="${esc(pid)}" style="--c:${v.color}">
        <div class="tape-name"><span class="swatch" style="--c:${v.color}"></span>${esc(p.name)}</div>
        <div class="tape"><div class="tape-view"><div class="tape-inner"></div></div></div>
      </div>`;
    }).join('');
    rows.forEach(renderTape);
  }

  function marksHtml(code) {
    if (!S.showMarks || !code) return '';
    return `<span class="marks">${[...code].map(c => `<i class="${c === '.' ? 'd' : 'h'}"></i>`).join('')}</span>`;
  }

  function cellHtml(pid, it) {
    if (it.ch === ' ') return `<div class="cell space" data-id="${it.id}"></div>`;
    let ch = it.ch, cls = it.state, meta = '', style = '';
    if (it.state === 'open') ch = pid === ME ? it.ch : '?';
    if (it.state === 'won') {
      const w = players.get(it.by);
      const c = w ? (VOICES[w.voice] || VOICES[0]).color : '#888';
      style = ` style="--w:${c}"`;
      meta = `<span class="meta">${esc(w ? w.name : '?')} · ${(it.ms / 1000).toFixed(1)}s</span>`;
    }
    if (it.team) {
      if (it.state === 'open') {
        meta = `<span class="meta progress">${it.myGuess ? 'guessed · ' : ''}${it.guessed}/${it.eligible}</span>`;
      } else if (it.state === 'done') {
        const dots = it.correct.map(q => {
          const w = players.get(q);
          return `<i style="--w:${w ? (VOICES[w.voice] || VOICES[0]).color : '#888'}" title="${esc(w ? w.name : '?')}"></i>`;
        }).join('');
        cls += it.correct.length ? ' got' : ' nobody';
        meta = `<span class="meta team-result">${dots}${it.correct.length}/${it.eligible}${it.keyerScored ? ' ★' : ''}</span>`;
        if (it.target && it.target !== it.ch) meta += `<span class="meta wanted">wanted ${esc(it.target)}</span>`;
      }
    }
    if (it.typed) cls += ' typed';
    return `<div class="cell ${cls}" data-id="${it.id}"${style}><span class="ch">${esc(ch)}</span>${marksHtml(it.code)}${meta}</div>`;
  }

  function liveHtml(pid) {
    const l = live.get(pid);
    if (!l || (!l.code && !l.down)) return '';
    return `<div class="cell live${l.down ? ' down' : ''}"><span class="ch">&nbsp;</span>${marksHtml(l.code)}</div>`;
  }

  function renderTape(pid) {
    const row = document.querySelector(`.tape-row[data-pid="${CSS.escape(pid)}"]`);
    if (!row) { renderTapes(); return; }
    const inner = row.querySelector('.tape-inner');
    const items = tapes.get(pid) || [];
    inner.innerHTML = items.map(it => cellHtml(pid, it)).join('') + liveHtml(pid) +
      (items.length || live.has(pid) ? '' : '<span class="tape-empty">—</span>');
    const view = row.querySelector('.tape-view');
    view.scrollLeft = view.scrollWidth;
  }

  function renderLive(pid) {
    renderTape(pid);
    const chip = document.querySelector(`.player[data-pid="${CSS.escape(pid)}"]`);
    const l = live.get(pid);
    if (chip) chip.classList.toggle('keying', !!(l && (l.down || l.code)));
  }

  function flashCell(pid, id) {
    const el = document.querySelector(`.tape-row[data-pid="${CSS.escape(pid)}"] .cell[data-id="${id}"]`);
    if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
  }

  // ======================================================================
  // Toasts
  // ======================================================================
  function toast(html, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  // ======================================================================
  // Keyer
  // ======================================================================
  const keyBtn = $('#key'), cardEl = $('#card'), treeEl = $('#tree');
  Card.render(cardEl, treeEl, Object.fromEntries(Object.entries(MORSE.letters).map(([ch, code]) => [code, ch])));

  let down = false, t0 = 0, code = '', letterTimer = 0, wordTimer = 0, raf = 0;
  const unit = () => 1200 / S.wpm;
  const symFor = ms => (ms >= 2 * unit() ? '-' : '.');

  let turnToastAt = 0;
  function press() {
    if (down || !net) return;
    if (mode === 'team' && !myTurn()) {
      if (Date.now() - turnToastAt > 2500) { turnToastAt = Date.now(); toast(`It's ${esc(nameOf(turn.pid))}'s turn to key`); }
      return;
    }
    Sound.ensure();
    down = true;
    t0 = performance.now();
    clearTimeout(letterTimer); clearTimeout(wordTimer);
    if (S.hearSelf) Sound.selfDown(voiceOf(ME));
    send({ t: 'down', kt: t0 });
    Card.transmitting(true);
    keyBtn.classList.add('down');
    if (!code) Card.clear();
    setLocal(true);
    preview();
  }
  function preview() {
    if (!down) return;
    Card.setPending(code + symFor(performance.now() - t0));
    raf = requestAnimationFrame(preview);
  }
  function release() {
    if (!down) return;
    down = false;
    cancelAnimationFrame(raf);
    Card.setPending(null);
    const now = performance.now();
    const sym = symFor(now - t0);
    Sound.selfUp();
    send({ t: 'up', kt: now, sym });
    Card.transmitting(false);
    keyBtn.classList.remove('down');
    code += sym;
    Card.lightPath(code);
    if (!PREFIXES.has(code)) Card.flashError(code);
    setLocal(false, sym);
    letterTimer = setTimeout(commitLetter, 3 * unit());
    wordTimer = setTimeout(() => send({ t: 'space' }), 7 * unit());
  }
  function commitLetter() {
    if (!code) return;
    send({ t: 'letter', code, ch: MORSE_CODE_TO_CHAR[code] || null });
    code = '';
    Card.clear();
    live.delete(ME);
    renderLive(ME);
  }
  // Show your own dots and dashes on your tape as you key.
  function setLocal(isDown, sym) {
    const l = live.get(ME) || { code: '' };
    l.down = isDown;
    l.at = Date.now() + 60000;
    if (sym) l.code += sym;
    live.set(ME, l);
    renderLive(ME);
  }

  const startKey = e => { e.preventDefault(); try { e.target.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } press(); };
  const endKey = e => { e.preventDefault(); release(); };
  for (const el of [keyBtn, cardEl]) {
    el.addEventListener('pointerdown', startKey);
    el.addEventListener('pointerup', endKey);
    el.addEventListener('pointercancel', endKey);
    el.addEventListener('lostpointercapture', endKey);
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ======================================================================
  // Keyboard: Space keys; other keys guess (Race) or type (Chat)
  // ======================================================================
  const chatInput = $('#chatInput');
  const inRoom = () => !$('#room').hidden && $('#drawer').getAttribute('aria-hidden') === 'true';
  const typingInField = el => el && (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  const GUESSABLE = /^[A-Za-z0-9.,?'!/()&:;=+\-_"$@]$/;

  document.addEventListener('keydown', e => {
    if (!inRoom() || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = document.activeElement;
    if (e.code === 'Space' && !typingInField(target)) {
      e.preventDefault();
      if (target && target.tagName === 'BUTTON') target.blur();
      if (!e.repeat) press();
      return;
    }
    if (typingInField(target)) return;
    if ((mode === 'race' || mode === 'team') && GUESSABLE.test(e.key)) {
      e.preventDefault();
      guess(e.key.toUpperCase());
    } else if (mode === 'chat' && e.key.length === 1) {
      e.preventDefault();
      chatInput.focus();
      typeChar(e.key);
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && !typingInField(document.activeElement)) { e.preventDefault(); release(); }
  });
  window.addEventListener('blur', release);

  // ---- Race: guessing ----
  let lockUntil = 0, lockTimer = 0;
  function guess(ch) {
    if (Date.now() < lockUntil) return;
    const box = $('#guessBox');
    box.textContent = ch;
    box.className = 'guess-box sent';
    $('#guessMsg').textContent = '';
    send({ t: 'guess', ch });
  }
  function onGuessResult(m) {
    const box = $('#guessBox'), msg = $('#guessMsg');
    box.textContent = m.ch;
    box.className = 'guess-box ' + m.result;
    if (m.team && m.result === 'right') msg.textContent = 'Right!';
    else if (m.team && m.result === 'wrong') msg.textContent = 'Not quite. The answer shows when the letter closes.';
    else if (m.result === 'right') msg.textContent = `Yes! ${(m.ms / 1000).toFixed(2)} s`;
    else if (m.result === 'pending') msg.textContent = 'Waiting for the letter to finish…';
    else if (m.result === 'nothing') msg.textContent = 'Nothing to guess yet.';
    else if ((m.result === 'wrong' || m.result === 'locked') && m.lockMs) {
      msg.textContent = m.result === 'wrong' ? 'Nope — wait a second' : 'Locked…';
      lockUntil = Date.now() + m.lockMs;
      $('#guessPanel').classList.add('locked');
      clearTimeout(lockTimer);
      lockTimer = setTimeout(() => { $('#guessPanel').classList.remove('locked'); msg.textContent = ''; }, m.lockMs);
    }
  }

  // ---- Chat: typing ----
  function typeChar(ch) {
    if (ch === ' ' || MORSE_CHAR_TO_CODE[ch.toUpperCase()]) send({ t: 'type', ch });
  }
  chatInput.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace') { e.preventDefault(); send({ t: 'backspace' }); }
    else if (e.key === 'Enter') { e.preventDefault(); send({ t: 'type', ch: ' ' }); }
    else if (e.key.length === 1) { e.preventDefault(); typeChar(e.key); }
  });
  // Mobile keyboards often skip keydown details; fall back to input events.
  chatInput.addEventListener('input', () => {
    for (const ch of chatInput.value) typeChar(ch);
    chatInput.value = '';
  });

  // ---- Room buttons ----
  document.querySelectorAll('.mode button').forEach(b =>
    b.addEventListener('click', () => { if (b.dataset.mode !== mode) send({ t: 'mode', mode: b.dataset.mode }); }));
  document.querySelectorAll('#challengeSeg button').forEach(b =>
    b.addEventListener('click', () => {
      const on = b.dataset.challenge === '1';
      if (on !== challenge) send({ t: 'setChallenge', on });
    }));
  $('#skipBtn').addEventListener('click', () => send({ t: 'skip' }));
  $('#skipMoleBtn').addEventListener('click', () => send({ t: 'skipMole' }));
  $('#passBtn').addEventListener('click', () => send({ t: 'pass' }));
  const sendKeyers = () => send({ t: 'setKeyers', rule: $('#keyerRule').value, n: +$('#turnN').value || 5 });
  $('#keyerRule').addEventListener('change', sendKeyers);
  $('#turnN').addEventListener('change', sendKeyers);
  $('#clearBtn').addEventListener('click', () => { if (confirm('Clear everyone\'s tapes?')) send({ t: 'clear' }); });
  $('#resetBtn').addEventListener('click', () => { if (confirm('Reset all scores to 0?')) send({ t: 'resetScores' }); });

  // ======================================================================
  // Settings drawer
  // ======================================================================
  const drawer = $('#drawer'), scrim = $('#scrim');
  function openSettings(open) {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    scrim.hidden = !open;
  }
  $('#settingsBtn').addEventListener('click', () => openSettings(true));
  $('#closeSettings').addEventListener('click', () => openSettings(false));
  scrim.addEventListener('click', () => openSettings(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') openSettings(false); });

  function renderCardVisibility() { cardEl.hidden = !S.showCard; }

  function bindSettings() {
    const name = $('#setName');
    name.value = S.name;
    name.addEventListener('change', () => {
      const n = name.value.trim().slice(0, 24);
      if (!n) { name.value = S.name; return; }
      S.name = n; nameInput.value = n; save();
      send({ t: 'name', name: n });
    });

    const wpm = $('#setWpm');
    wpm.value = S.wpm; $('#wpmOut').textContent = `${S.wpm} WPM`;
    wpm.addEventListener('input', () => { S.wpm = +wpm.value; $('#wpmOut').textContent = `${S.wpm} WPM`; save(); });
    wpm.addEventListener('change', () => send({ t: 'wpm', wpm: S.wpm }));

    const checks = { setShowCard: 'showCard', setHearSelf: 'hearSelf', setHearOthers: 'hearOthers', setShowMarks: 'showMarks', setPlayTyped: 'playTyped' };
    for (const [id, key] of Object.entries(checks)) {
      const el = $('#' + id);
      el.checked = S[key];
      el.addEventListener('change', () => {
        S[key] = el.checked; save();
        if (key === 'showCard') renderCardVisibility();
        if (key === 'showMarks') renderTapes();
      });
    }
    document.querySelectorAll('input[name="toneStyle"]').forEach(r => {
      r.checked = r.value === S.toneStyle;
      r.addEventListener('change', () => { S.toneStyle = r.value; save(); });
    });

    const vol = $('#setVolume');
    vol.value = S.volume; $('#volOut').textContent = Math.round(S.volume * 100) + '%';
    Sound.setVolume(S.volume);
    vol.addEventListener('input', () => {
      S.volume = +vol.value; save();
      Sound.setVolume(S.volume);
      $('#volOut').textContent = Math.round(S.volume * 100) + '%';
    });
  }
  bindSettings();
  renderCardVisibility();

  if (codeInput.value) (S.name ? $('#joinBtn') : nameInput).focus();
  else nameInput.focus();
})();
