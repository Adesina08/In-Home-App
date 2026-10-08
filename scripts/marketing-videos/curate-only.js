// Re-run just the review + approval on the existing generated summary (no new Gemini calls).
process.argv.push('--curate-only');
require('./video-summary.js');
