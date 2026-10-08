# Marketing videos

Scripted walkthroughs of the app, recorded against a throwaway demo database and edited into 1920×1080 MP4s with title cards, captions and music.

The study, respondents, phone numbers and brand names are fictional. Photos and video clips are real, unbranded stock footage from Pixabay (Content License: free for commercial use, no attribution required). The respondents' voices are AI-generated (Gemini text-to-speech). The real database is never used. From `.env`, only the Gemini, Azure Vision and Pixabay keys are used, and only on demo data: for the AI summary, the Video Summary pipeline, the AI-assisted entry analysis, and the voices.

## Videos

| Name | Shows |
| --- | --- |
| `study-creation` | Creating a study, building the questionnaire, preview, inviting a respondent |
| `respondent-onboarding` | Invite link → consent → pre-survey → code verification → profile → app or WhatsApp → login |
| `diary-entry` | Logging an entry on a phone, with a live camera photo |
| `ai-entry` | AI-assisted entry: the respondent records a video (AI voice), real Azure Vision + Gemini analysis fills the answers, a researcher confirms them |
| `rewards` | Staff set NGN reward milestones and the celebration, then send a reward to finance and record the payment; the respondent's real mobile app (web export) shows the confetti celebration and reward progress |
| `results-insights` | Fieldwork dashboard, charts, crosstabs, quality control, AI summary, media gallery, Video Summary reel, client portal |

## Making them

```bash
cd scripts/marketing-videos
npm install                     # once: Playwright (uses the Chromium already in ~/.cache/ms-playwright)
node music.js                   # once: writes the original music bed to .work/music.wav
node stock.js search            # once: Pixabay candidates + contact sheets (PIXABAY_API_KEY in .env)
node stock.js get <ids...>      # download the chosen photos/clips into .work/stock/picked/
./reset.sh                      # fresh demo database: AI voices, stock media, AI summary, Video Summary (Gemini)
./serve.sh &                    # demo server on http://localhost:3100
node serve-mobile.js &          # mobile app web build on :8090 (rewards video; build steps in serve-mobile.js)
./make-video.sh all             # record + edit every video into .work/out/
```

Other options:

- `./make-video.sh diary-entry`: make one video. Run `./reset.sh` first, because flows change the demo data.
- `--edit-only`: re-edit the last recording, e.g. after changing caption styling in `compose.js`.
- `--music path/to/track.mp3`: use a licensed track instead of the generated bed. `--no-music` makes the video silent.

`make-video.sh` runs inside a 3 GB memory cap, so a runaway browser or encoder stops on its own instead of starving the machine.

## How it works

- **`demo-env.sh` / `reset.sh` / `enrich.js`**: the demo database (`.work/demo.localdb.json`) with every external service mocked. `reset.sh` refuses to run against anything else.
- **`demo-messaging.js`**: preloaded by `serve.sh` only. Mock messages report "delivered" (so screens match a deployment with messaging connected) and are written to `.work/inbox.jsonl`, where the recorder reads verification codes.
- **`rec.js`**: drives Chromium with an animated cursor (a tap circle on phone flows), captures crisp frames, and logs caption cues.
- **`voice.js`**: AI-voiced diary lines (Gemini TTS), laid over the stock clips. The free tier is rate-limited, so the script waits and retries.
- **`video-summary.js`**: runs the app's real Video Summary pipeline, then a researcher-style review (curated findings, a corrected brand name) through the app's own review function, and approves it. `node curate-only.js` re-runs just the review.
- **`flows/*.js`**: one script per video. Captions are the `r.cue(...)` lines. `ai-entry` plays the stock clip and AI voice as the phone camera and microphone, waits for the real analysis, then records the review screen. Its demo entries are then excluded via the record-review action, so the Video Summary stays current.
- **`rec.js` pause/save**: `r.save()` clicks a submit and pauses capture through the page reload; `r.resume()` continues, so reloads are cut from the video.
- **`compose.js`**: renders cards and captions as HTML in Chromium, then assembles the video with ffmpeg in three low-memory passes.
