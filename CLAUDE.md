# CLAUDE.md

Notes for working on Morse Party. See README.md for what the game does.

## Shape of the project

- Static site: plain HTML, CSS and JavaScript, no build step, no npm dependencies. Published to GitHub Pages from `main` (https://mattcruikshank.github.io/MorseParty/). A push to `main` is a deploy.
- Scripts are classic `<script>` tags loaded in order from `index.html` (globals, not modules): `lib/peerjs.min.js`, `morse.js`, `tree.js`, `card.js`, `ref.js`, `audio.js`, `room.js`, `net.js`, `app.js`.
- Networking is WebRTC through PeerJS 1.5.4, vendored in `lib/` with its license. There is no server of ours. Room peer IDs are `morseparty-` plus a 5-character code. A self-hosted PeerServer would go in `PEER_OPTIONS` in `js/net.js`.
- The host's browser is the referee. `js/room.js` (`Room`) holds all game rules and state and must stay free of DOM code so it runs under Node for tests. Clients send intents; the host broadcasts state and events.
- `js/card.js` and `js/tree.js` come from the sibling project `../MorseCode`. Keep them close to the original so changes can be shared.

## State

- Per-browser settings: localStorage key `morseparty.settings` (defaults in `app.js`). Old keys get migrated there, not dropped silently.
- Player identity: sessionStorage, overridable with `?pid=` (the tests use this to run two players in one browser).
- Scores are one shared tally across the scoring modes, cleared by Reset scores.

## Layout rule

Nothing should move while playing, especially on phones. Panels that change during play have fixed sizes or reserved slots: hide things with the `.invisible` class (keeps space) rather than `hidden`, give changing text a fixed-height slot, and don't let panels wrap. Only mode switches may rearrange the page. Check with `test/shifts.html` after layout changes.

## Testing

- `node test/room.test.js`: game-rule unit tests. Add a test here when changing rules in `room.js`.
- Browser tests need a local server from the repo root: `python -m http.server 8765` (stop it afterwards).
- `node test/e2e.mjs "<path to msedge.exe>" out.png [harness URL]` drives headless Edge through CDP with a fresh profile. Default harness is `test/harness.html` (two players, full flow through each mode). Others: `test/helpers.html` (key helpers), `test/shifts.html` (layout-shift recorder at phone width).
- On this machine Edge is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`.
- Headless tests never hear audio. Sound changes need a check by ear.
- Browser tests use PeerJS's public server, so they need internet access.

## Conventions

- Keep README.md in step with modes, settings and files.
- Never commit secrets; write `<PLACEHOLDER>` instead.
- Files use LF line endings and UTF-8.
