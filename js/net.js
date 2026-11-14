// Networking with WebRTC through PeerJS.
//
// The host's browser runs the Room and accepts data connections from guests.
// PeerJS's public server is used only to introduce browsers to each other; game
// traffic then flows directly between them (or through PeerJS's TURN relay when
// a direct path isn't possible).
//
// To use our own matchmaking server later (e.g. a PeerServer on Tailscale Funnel),
// change PEER_OPTIONS, for example:
//   { host: 'match.example.ts.net', port: 443, path: '/', secure: true }
const Net = (() => {
  const PREFIX = 'morseparty-';
  const PEER_OPTIONS = { debug: 1 };
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  const newCode = () =>
    Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  /** Host a new room. Resolves to { code, send(msg), close() }. */
  function host({ pid, onMessage, onStatus }) {
    return new Promise((resolve, reject) => {
      let opened = false;
      const attempt = n => {
        const code = newCode();
        const peer = new Peer(PREFIX + code, PEER_OPTIONS);
        const conns = new Map(); // guest pid -> DataConnection
        const room = new Room((to, msg) => {
          if (to === pid) queueMicrotask(() => onMessage(msg));
          else {
            const c = conns.get(to);
            if (c && c.open) c.send(msg);
          }
        });

        peer.on('open', () => {
          opened = true;
          resolve({ code, send: msg => room.handle(pid, msg), close: () => peer.destroy() });
        });

        peer.on('connection', conn => {
          let cpid = null;
          conn.on('data', msg => {
            if (!cpid) {
              if (!msg || msg.t !== 'hello' || typeof msg.pid !== 'string' || msg.pid === pid) return;
              cpid = msg.pid.slice(0, 40);
              const old = conns.get(cpid);
              if (old && old !== conn) old.close();
              conns.set(cpid, conn);
            }
            room.handle(cpid, msg);
          });
          const gone = () => {
            if (cpid && conns.get(cpid) === conn) {
              conns.delete(cpid);
              room.leave(cpid);
            }
          };
          conn.on('close', gone);
          conn.on('error', gone);
        });

        peer.on('disconnected', () => {
          // Lost the matchmaking server. Players already connected are unaffected;
          // reconnect so new players can still find the room.
          if (!peer.destroyed) setTimeout(() => peer.reconnect(), 2000);
        });

        peer.on('error', err => {
          if (!opened && err.type === 'unavailable-id' && n < 5) { peer.destroy(); attempt(n + 1); return; }
          if (!opened) { reject(err); return; }
          onStatus && onStatus('error', err);
        });
      };
      attempt(0);
    });
  }

  /** Join a room by code. Returns { send(msg), close() }. */
  function join({ code, onMessage, onStatus }) {
    const peer = new Peer(PEER_OPTIONS);
    let conn = null, closed = false, retry = 0;

    const again = ms => { clearTimeout(retry); if (!closed) retry = setTimeout(connect, ms); };
    function connect() {
      if (closed || peer.destroyed) return;
      if (peer.disconnected) { peer.reconnect(); return; }
      onStatus('connecting');
      const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn = c;
      c.on('open', () => onStatus('open'));
      c.on('data', msg => { if (conn === c) onMessage(msg); });
      c.on('close', () => { if (conn === c && !closed) { onStatus('lost'); again(2000); } });
      c.on('error', () => { if (conn === c && !closed) again(2000); });
    }

    peer.on('open', connect);
    peer.on('disconnected', () => { if (!closed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000); });
    peer.on('error', err => {
      if (closed) return;
      if (err.type === 'peer-unavailable') { onStatus('nohost'); again(3000); }
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') { onStatus('lost'); }
      else onStatus('error', err);
    });

    return {
      send: msg => { if (conn && conn.open) conn.send(msg); },
      close: () => { closed = true; clearTimeout(retry); peer.destroy(); },
    };
  }

  return { host, join, newCode, cleanCode };
})();
