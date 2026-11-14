// International Morse Code tables, grouped so each group can be toggled in Settings.
// "." = dot (dit), "-" = dash (dah).
const MORSE = {
  letters: {
    A: '.-',   B: '-...', C: '-.-.', D: '-..',  E: '.',    F: '..-.', G: '--.',
    H: '....', I: '..',   J: '.---', K: '-.-',  L: '.-..', M: '--',   N: '-.',
    O: '---',  P: '.--.', Q: '--.-', R: '.-.',  S: '...',  T: '-',    U: '..-',
    V: '...-', W: '.--',  X: '-..-', Y: '-.--', Z: '--..'
  },
  numbers: {
    '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
    '6': '-....', '7': '--...', '8': '---..', '9': '----.', '0': '-----'
  },
  punctuation: {
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--',
    '/': '-..-.',  '(': '-.--.',  ')': '-.--.-', '&': '.-...',  ':': '---...',
    ';': '-.-.-.', '=': '-...-',  '+': '.-.-.',  '-': '-....-', '_': '..--.-',
    '"': '.-..-.', '$': '...-..-', '@': '.--.-.'
  }
};

// Flat lookups across every group.
const MORSE_CHAR_TO_CODE = {};
const MORSE_CODE_TO_CHAR = {};
for (const group of Object.values(MORSE)) {
  for (const [ch, code] of Object.entries(group)) {
    MORSE_CHAR_TO_CODE[ch] = code;
    MORSE_CODE_TO_CHAR[code] = ch;
  }
}
