// Synthesises an original, royalty-free music bed (calm, uplifting) to .work/music.wav.
// Soft chord pads, a plucked arpeggio and a light bass over a C–Am–F–G loop.
// Replace it with any licensed track via: node run.js all --music track.mp3
const fs = require('fs');
const path = require('path');
const { WORK } = require('./config');

const RATE = 44100, BPM = 96, BEAT = 60 / BPM, BAR = BEAT * 4, SECONDS = 128;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Chords as MIDI notes (pad voicing) with their bass roots; two bars each.
const CHORDS = [
  { pad: [60, 64, 67, 71], bass: 36 }, // Cmaj7
  { pad: [57, 60, 64, 67], bass: 33 }, // Am7
  { pad: [53, 57, 60, 64], bass: 29 }, // Fmaj7
  { pad: [55, 59, 62, 67], bass: 31 }, // G
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3]; // indexes into the pad notes, an octave up, as 8th notes

const n = Math.floor(SECONDS * RATE);
const L = new Float32Array(n), R = new Float32Array(n);
const add = (i, l, r) => { if (i >= 0 && i < n) { L[i] += l; R[i] += r; } };

function tone(start, dur, freq, amp, { attack = 0.01, release = 0.3, decay = 0, pan = 0, harmonics = [1] } = {}) {
  const s0 = Math.floor(start * RATE), len = Math.floor((dur + release) * RATE);
  for (let k = 0; k < len; k++) {
    const t = k / RATE;
    let env = t < attack ? t / attack : 1;
    if (decay) env *= Math.exp(-t / decay);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    let v = 0;
    harmonics.forEach((h, j) => { v += Math.sin(2 * Math.PI * freq * (j + 1) * t) * h; });
    v *= amp * env;
    add(s0 + k, v * (1 - pan) * 0.5 + v * 0.5, v * (1 + pan) * 0.5 + v * 0.5);
  }
}

const loopLen = BAR * 2 * CHORDS.length;
for (let t0 = 0; t0 < SECONDS; t0 += loopLen) {
  CHORDS.forEach((c, ci) => {
    const start = t0 + ci * BAR * 2;
    if (start >= SECONDS) return;
    // Pads: slow swells, slightly detuned pairs spread across the stereo field.
    c.pad.forEach((note, vi) => {
      const pan = (vi / (c.pad.length - 1)) * 1.2 - 0.6;
      tone(start, BAR * 2, midi(note), 0.035, { attack: 1.2, release: 1.4, pan, harmonics: [1, 0.25, 0.08] });
      tone(start, BAR * 2, midi(note) * 1.003, 0.025, { attack: 1.4, release: 1.4, pan: -pan, harmonics: [1, 0.2] });
    });
    // Bass: root on beats 1 and 3.
    for (let b = 0; b < 4; b++) tone(start + b * BAR / 2, BEAT * 1.6, midi(c.bass), 0.11, { attack: 0.02, decay: 0.9, release: 0.2, harmonics: [1, 0.35, 0.1] });
    // Plucked arpeggio from the second loop on, so the opening breathes.
    if (t0 > 0 || ci >= 2) {
      for (let e = 0; e < 16; e++) {
        const note = c.pad[ARP[e % ARP.length]] + 12;
        tone(start + e * BEAT / 2, BEAT / 2, midi(note), 0.05, { attack: 0.004, decay: 0.35, release: 0.15, pan: e % 2 ? 0.35 : -0.35, harmonics: [1, 0.5, 0.18, 0.06] });
      }
    }
  });
}

// Ping-pong delay for space, then normalise and fade the very ends.
const d = Math.floor(BEAT * 0.75 * RATE);
for (let i = d; i < n; i++) { L[i] += R[i - d] * 0.28; R[i] += L[i - d] * 0.28; }
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = 0.6 / peak, fade = RATE * 2;
const buf = Buffer.alloc(44 + n * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) {
  const f = Math.min(1, i / fade, (n - i) / fade);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain * f)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain * f)) * 32767), 46 + i * 4);
}
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'music.wav'), buf);
console.log(`music.wav: ${SECONDS}s original music bed`);
