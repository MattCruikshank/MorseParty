// Key helpers: the alphabet, or a QWERTY keyboard, with Morse under each character.
// Lights up the characters still possible while you key, like the card does.
const RefChart = (() => {
  const ALPHABET = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', '1234567890'];
  // Real keyboard rows, keeping only keys that have a Morse code. `indent` is in key widths.
  const KEYBOARD = [
    // `mobile` is the indent on phones, where only the 10-wide letter rows are shown.
    { keys: '1234567890-=', indent: 0, mobile: 0 },
    { keys: 'QWERTYUIOP', indent: 0.5, mobile: 0 },
    { keys: 'ASDFGHJKL;', indent: 0.75, mobile: 0.5 },
    { keys: 'ZXCVBNM,./', indent: 1.25, mobile: 1.5 },
  ];

  let box = null, tiles = new Map(), badTimer = 0;
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function tile(ch) {
    const code = MORSE_CHAR_TO_CODE[ch];
    if (!code) return '';
    const marks = [...code].map(c => `<i class="${c === '.' ? 'd' : 'h'}"></i>`).join('');
    const extra = /[A-Z]/.test(ch) ? '' : ' extra';
    return `<div class="rk${extra}" data-ch="${esc(ch)}" data-code="${code}"><span class="rk-ch">${esc(ch)}</span><span class="rk-marks">${marks}</span></div>`;
  }

  function render(el, layout) {
    box = el;
    if (layout === 'keyboard') {
      el.className = 'ref keyboard';
      el.innerHTML = KEYBOARD.map(r =>
        `<div class="ref-row${/[A-Z]/.test(r.keys) ? '' : ' extra-row'}" style="--indent:${r.indent};--indent-m:${r.mobile}">${[...r.keys].map(tile).join('')}</div>`).join('');
    } else {
      el.className = 'ref alphabet';
      el.innerHTML = ALPHABET.map((r, i) =>
        `<div class="ref-grid${i ? ' digits' : ''}">${[...r].map(tile).join('')}</div>`).join('');
    }
    tiles = new Map();
    el.querySelectorAll('.rk').forEach(t => tiles.set(t, t.dataset.code));
  }

  // Highlight what's still possible for the code keyed so far ('' clears).
  function show(code) {
    if (!box) return;
    box.classList.toggle('keying', !!code);
    for (const [t, c] of tiles) {
      t.classList.toggle('possible', !!code && c.startsWith(code));
      t.classList.toggle('current', !!code && c === code);
    }
  }

  function flashError() {
    if (!box) return;
    clearTimeout(badTimer);
    box.classList.add('bad');
    badTimer = setTimeout(() => box.classList.remove('bad'), 650);
  }

  // Outline the character you're meant to key (Challenge / Whack-a-Mole).
  function setGoal(ch) {
    for (const t of tiles.keys()) t.classList.toggle('goal', !!ch && t.dataset.ch === ch);
  }

  return { render, show, flashError, setGoal };
})();
