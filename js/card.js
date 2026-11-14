// The light-up Morse tree card (ported from the MorseCode trainer).
const Card = (() => {
  const CW = 64, CH = 60, PAD = 34, TOP = 46;
  let treeEl, cardEl, nodeEls = new Map(), edgeEls = new Map(), antennaEl = null;
  let pendingCode = null, badTimer = 0;
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(card, tree, codeToChar) {
    cardEl = card; treeEl = tree;
    const { items, edges } = layoutMorseTree(buildMorseTree(codeToChar));
    let minX = 0, maxX = 0, maxY = 0;
    for (const it of items) { minX = Math.min(minX, it.x); maxX = Math.max(maxX, it.x); maxY = Math.max(maxY, it.y); }
    const W = (maxX - minX) * CW + PAD * 2;
    const H = maxY * CH + PAD * 2 + TOP;
    const X = x => (x - minX) * CW + PAD;
    const Y = y => y * CH + PAD + TOP;

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Morse code tree">`;
    for (const e of edges) {
      svg += `<line class="trace" data-code="${e.code}" x1="${X(e.x1)}" y1="${Y(e.y1)}" x2="${X(e.x2)}" y2="${Y(e.y2)}"/>`;
    }
    const ax = X(0), ay = Y(0);
    svg += `<g class="antenna">
      <line class="stem" x1="${ax}" y1="${ay}" x2="${ax}" y2="${ay - 22}"/>
      <path class="flare" d="M${ax - 14} ${ay - 44} L${ax + 14} ${ay - 44} L${ax + 3} ${ay - 22} L${ax - 3} ${ay - 22} Z"/>
      <path class="wave" d="M${ax - 22} ${ay - 52} q-8 10 0 20 M${ax + 22} ${ay - 52} q8 10 0 20"/>
      <path class="wave" d="M${ax - 30} ${ay - 58} q-12 16 0 32 M${ax + 30} ${ay - 58} q12 16 0 32"/>
    </g>`;
    for (const it of items) {
      const n = it.node, cx = X(it.x), cy = Y(it.y);
      const isDash = n.code[n.code.length - 1] === '-';
      const junction = !n.ch;
      const k = junction ? 0.65 : 1;
      let shape;
      if (isDash) {
        const w = (it.via === 'h' ? 36 : 16) * k, h = (it.via === 'h' ? 16 : 36) * k;
        shape = `<rect class="shape" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="2"/>`;
      } else {
        shape = `<circle class="shape" cx="${cx}" cy="${cy}" r="${13 * k}"/>`;
      }
      let label = '';
      if (n.ch) {
        let lx, ly, anchor;
        if (it.via === 'h') { lx = cx; ly = cy - (isDash ? 15 : 20); anchor = 'middle'; }
        else {
          const off = isDash ? 15 : 20;
          lx = cx - it.side * off; ly = cy + 7; anchor = it.side > 0 ? 'end' : 'start';
        }
        label = `<text x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(n.ch)}</text>`;
      }
      svg += `<g class="node ${isDash ? 'dash' : 'dot'}${junction ? ' junction' : ''}" data-code="${n.code}">${shape}${label}</g>`;
    }
    svg += '</svg>';
    treeEl.innerHTML = svg;

    nodeEls = new Map(); edgeEls = new Map();
    treeEl.querySelectorAll('.node').forEach(g => nodeEls.set(g.dataset.code, g));
    treeEl.querySelectorAll('.trace').forEach(l => edgeEls.set(l.dataset.code, l));
    antennaEl = treeEl.querySelector('.antenna');
    cardEl.style.maxWidth = Math.round(W + 44) + 'px';
  }

  const clearClass = cls => treeEl && treeEl.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls));

  function lightPath(c) {
    clearClass('lit'); clearClass('current');
    for (let i = 1; i <= c.length; i++) {
      const p = c.slice(0, i), g = nodeEls.get(p);
      if (!g) break;
      g.classList.add('lit');
      edgeEls.get(p)?.classList.add('lit');
      if (i === c.length) g.classList.add('current');
    }
  }

  function setPending(c) {
    if (c === pendingCode) return;
    if (pendingCode) nodeEls.get(pendingCode)?.classList.remove('pending');
    pendingCode = c;
    if (c) nodeEls.get(c)?.classList.add('pending');
  }

  function flashError(c) {
    clearTimeout(badTimer);
    clearClass('bad'); clearClass('lit'); clearClass('current');
    for (let i = 1; i <= c.length; i++) nodeEls.get(c.slice(0, i))?.classList.add('bad');
    antennaEl?.classList.add('err');
    cardEl.classList.remove('shake'); void cardEl.offsetWidth; cardEl.classList.add('shake');
    badTimer = setTimeout(() => { clearClass('bad'); antennaEl?.classList.remove('err'); }, 650);
  }

  function transmitting(on) { antennaEl?.classList.toggle('tx', on); }
  function clear() { clearClass('lit'); clearClass('current'); }
  const has = code => nodeEls.has(code);

  return { render, lightPath, setPending, flashError, transmitting, clear, has };
})();
