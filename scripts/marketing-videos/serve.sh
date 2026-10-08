#!/bin/bash
# Run the app against the demo database on http://localhost:3100.
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/demo-env.sh"
# AI summaries in the demo use Gemini with the key from the app's .env (demo data only).
export AI_SUMMARY_PROVIDER=gemini
real() { (cd "$HERE/../.." && node -e "process.stdout.write(require('dotenv').parse(require('fs').readFileSync('.env'))['$1'] || '')"); }
export GEMINI_API_KEY="$(real GEMINI_API_KEY)"
# AI-assisted (video) entries are analysed for real: OpenAI reads frames, Gemini transcribes speech.
export VIDEO_FIELD_EXTRACTION_PROVIDER=openai AUDIO_TRANSCRIPTION_PROVIDER=gemini_speech BRAND_DETECTION_PROVIDER=gemini_vision
export OPENAI_API_KEY="$(real OPENAI_API_KEY)"
cd "$HERE/../.." && exec node -r "$HERE/demo-messaging.js" server.js
