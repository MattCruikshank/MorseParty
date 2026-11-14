# Morse Party

Key Morse code with friends, peer-to-peer in the browser.

**Play: https://mattcruikshank.github.io/MorseParty/**

One person creates a room and shares the code or invite link. Everyone joins from their own browser.

## Modes

- **Race.** Anyone can key. Everyone else types the letter they hear, and the first right answer scores. A wrong guess locks you out for a second. Each keyer's letters build up on their own ticker tape, revealed once someone wins them, or after 6 seconds if nobody does.
- **Team.** Anyone can key, and every other player gets **one guess** per letter. Everyone who guesses right on their first try gets a point, and the keyer gets a point if at least one person got it. A letter closes when everyone has guessed, or after 8 seconds.
  - **Free play** or **Challenge**: in Challenge, the keyer is given a random letter to key. Guessers are judged on what was actually keyed, but the keyer only scores if they keyed the challenge letter.
  - **Who keys**: anyone, or take turns (1 letter each, or N letters each, like "I do 5, you do 5, Mary does 5"). The current keyer can pass the key.
- **Whack-a-Mole.** A letter pops up for everyone, and the first person to key it correctly gets the point. A new letter appears after a hit, after 15 seconds, or when someone skips.
- **Chat.** No right answers. Key or type, and everything you send goes on your own tape, like IRC in Morse.

Each player gets their own tone (pitch and waveform) and color.

## Settings (per browser)

- Keying speed (WPM), which sets the dash threshold and letter/word gaps
- Key helper: the Morse tree card, the alphabet, a QWERTY keyboard (each with the Morse code under every character), or nothing. While you key, the characters still possible light up (this can be turned off). Also switchable right above the key.
- Hear your own tone
- Hear others' tones, either **as keyed** (their real timing, live, with a small jitter buffer) or **cleaned up** (perfect timing after each letter)
- Show dots and dashes on the tapes
- Play typed chat messages as Morse
- Volume

## How it works

- Plain HTML, CSS and JavaScript, hosted on GitHub Pages. No build step.
- Connections use WebRTC data channels through [PeerJS](https://peerjs.com) 1.5.4 (MIT, vendored in `lib/`). PeerJS's free public server only introduces the browsers; after that, traffic goes directly between them (or through PeerJS's TURN relay when a direct path isn't possible).
- The room creator's browser is the referee: `js/room.js` holds the rules and state. If the host closes their tab, the room ends.
- To use a self-hosted PeerServer (for example on Tailscale Funnel), change `PEER_OPTIONS` in `js/net.js`.

| File | Purpose |
| --- | --- |
| `js/room.js` | Game rules and shared state (runs on the host) |
| `js/net.js` | PeerJS hosting/joining, room codes |
| `js/app.js` | UI, keyer, tapes, settings |
| `js/audio.js` | Sidetones: own key, live remote keying, cleaned-up playback |
| `js/ref.js` | Alphabet and QWERTY key helpers |
| `js/card.js`, `js/tree.js` | The light-up Morse tree card (from [MorseCode](https://github.com/MattCruikshank/MorseCode)) |

## Tests

- `node test/room.test.js` checks the game rules.
- `test/e2e.mjs` drives headless Edge through a real two-browser session (needs a local server on port 8765: `python -m http.server 8765`).
