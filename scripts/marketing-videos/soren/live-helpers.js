// Helpers for soren/live.js steps: run a recorded step and, if it fails, cut what it captured.
function clock(r) { return r.recording ? r.now() : (r.pausedAt - r.wallStart) / 1000 - r.paused; }
function rollback(r, T) {
  const over = clock(r) - T;
  if (r.recording) r.pause();
  r.frames = r.frames.filter((f) => f.t <= T);
  r.cues = r.cues.filter((c) => c.t < T);
  r.paused += Math.max(0, over);
  return over;
}
async function recorded(r, fn) {
  await r.resume();
  const T = clock(r);
  try { const out = await fn(); if (r.recording) r.pause(); return out; }
  catch (e) { const cut = rollback(r, T); return { error: e.message.split('\n').slice(0, 4).join(' '), cut }; }
}
module.exports = { recorded, rollback, clock };
