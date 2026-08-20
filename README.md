# INICIO In-Home Consumption App — Pilot MVP

A working functional prototype of the 3-week MVP spec: respondent onboarding (F2F + remote),
the diary engine with skip logic, photo/video evidence, a rule-based QC engine + worklist +
Green/Amber/Red risk classification, a reminder engine with a pluggable WhatsApp adapter,
an admin ops dashboard, a client dashboard, CSV export, and a **Developer/Config console**
so none of the business inputs (questionnaire, brands/SKUs, consent wording, diary
frequency, reminder schedule, recall window, QC thresholds, client KPIs) are hardcoded.

Also included: **upload a questionnaire** (CSV/XLSX, or best-effort from a Word/PDF doc) with
an editable preview + live rendered form preview before anything is committed; **video
evidence with a pluggable brand-detection provider** (mock by default, wired for Azure AI
Vision); and the respondent diary is an **installable mobile PWA** (manifest, service worker,
offline fallback, local draft autosave).

This is a prototype, not a production deployment — see `PRODUCTION_READINESS.md` for the
exact list of what's still needed (real WhatsApp credentials, HTTPS, SSO, managed database,
secrets management, backups, retention, monitoring, and release validation) before it
touches real respondent data. Three of the AI providers (Azure AI Vision for brand
detection + video pre-fill, Azure AI Speech for transcription) and media storage already
have real, working implementations behind an env-var flip — see the companion **Azure
Deployment Runbook** for exact Azure Portal/CLI steps to provision everything and deploy
this app for real, sized to fit an Azure free-account $200/30-day credit.

Every screen — staff and respondent — follows one consistent visual system (icon-accented
headers, rounded cards, a shared color/shadow/spacing scale). See `DESIGN_SYSTEM.md` for the
tokens and component conventions if extending the UI.

## Run it

```bash
npm install
cp .env.example .env
npm run build:css   # compiles the Tailwind stylesheet into public/tailwind.css
npm run seed         # wipes and re-seeds a sample pilot study
npm start             # http://localhost:3000
```

## Demo accounts (seeded)

| Role | Email | Password |
|---|---|---|
| Admin | admin@inicio.demo | Demo1234! |
| Research | research@inicio.demo | Demo1234! |
| Interviewer | interviewer@inicio.demo | Demo1234! |
| Client | client@inicio.demo | Demo1234! |

Respondents don't log in — each gets a unique link (`/r/<token>`), visible on the
Admin → Study → Respondents screen, or generated live via Interviewer → Register Respondent.

## Project layout

- `server.js` — Express app entry point, sessions, static file serving, root-scoped `/sw.js`
- `lib/db.js` — SQLite schema (studies, users, respondents, questions, skip rules, brands,
  consent, diary records, responses, media, QC flags, reminders, WhatsApp outbox, KPI
  config, question imports, audit log)
- `lib/qc.js` — the rule-based QC engine (back-entry window, missing photo, duplicate/
  repetitive, burst entry, range/logic, cross-channel duplicate) + risk classification
- `lib/reminders.js` — reminder scheduling engine
- `lib/whatsapp.js` — pluggable WhatsApp provider (mock by default; see PRODUCTION_READINESS.md)
- `lib/brandDetection.js` — pluggable brand-detection provider for photo/video evidence
  (mock by default; a real Azure AI Vision implementation is one `.env` flip away, see
  PRODUCTION_READINESS.md B9)
- `lib/videoFieldExtraction.js` — pluggable provider that pre-fills diary questions from a
  Video-mode entry's recording (mock by default, real implementation reuses the Azure AI
  Vision wiring; B9)
- `lib/audioTranscription.js` — pluggable provider that transcribes a Voice-Note-mode entry's
  recording (mock by default, real implementation calls Azure AI Speech; see
  PRODUCTION_READINESS.md B10)
- `lib/azureVisionClient.js`, `lib/ffmpegFrames.js` — shared helpers the two Vision-based
  providers above use (frame sampling for video uses a bundled ffmpeg binary, no system
  install needed)
- `lib/mediaStorage.js` — pluggable storage for uploaded media: local disk (default) or
  Azure Blob Storage (`STORAGE_PROVIDER=azure_blob`) with private containers and short-lived
  signed URLs — see PRODUCTION_READINESS.md B4
- `lib/questionnaireParser.js` — parses an uploaded CSV/XLSX/DOCX/PDF into staged question rows
- `routes/` — `auth.js`, `admin.js` (ops dashboard + Developer/Config console + questionnaire
  upload/preview + Media Review + QC worklist + export), `interviewer.js` (F2F onboarding),
  `client.js` (client dashboard), `respondent.js` (token-based diary flow + per-respondent
  PWA manifest)
- `views/` — EJS templates, styled with a locally-built Tailwind CSS bundle (no CDN
  dependency, works offline); respondent-facing views are mobile-first
- `public/manifest.json`, `public/sw.js`, `public/icons/` — PWA app shell (installable
  "Add to Home Screen", offline fallback page, static-asset caching)
- `lib/seed.js` — seeds a clearly-marked SAMPLE study end to end (including deliberately
  triggering several QC rules and a sample video-evidence item) so the app can be demoed
  immediately

## Replacing the sample data with a real pilot

Everything the spec calls "Day-1 inputs" is editable from the Developer/Config console —
no code changes needed:

Admin → Studies → (create or open your study) → tabs for **Settings & Thresholds**,
**Questionnaire Builder**, **Skip Logic**, **Brand / SKU List**, **Consent Wording**,
**Client KPIs**, **Media Review**.

## Uploading an existing questionnaire

Questionnaire Builder → **Upload Questionnaire**. Best results come from a `.csv`/`.xlsx`
with columns `code, text, type, options, required, min, max`; a `.docx`/`.pdf`/`.txt`
questionnaire is also accepted and parsed best-effort. Either way you land on a **Review
Import** screen — an editable table plus a live rendered preview of the diary form — and
nothing is added to your study until you click Commit.

## Three ways to log a diary entry

Tapping **Log Consumption** first asks the respondent how they'd like to log this entry:

- **Standard Form** — answer each question directly, same as before.
- **Video (AI-assisted)** — record one video first; it's analyzed by a pluggable field-
  extraction provider (mock by default — nothing is ever guessed, exactly like brand
  detection; a real Azure AI Vision implementation is available, see PRODUCTION_READINESS.md B9)
  that pre-fills whatever it can confidently identify, then the respondent completes the
  remaining questions and reviews/edits anything pre-filled before submitting.
- **Voice Note** — fill in the questions manually as usual, then record a short voice summary
  at the end. It's always attached as a QC-reviewable audio note and queued for transcription
  by a pluggable provider (mock by default; a real Azure AI Speech implementation is
  available, see PRODUCTION_READINESS.md B10).

Every diary record keeps track of which method was used (visible on the respondent's own diary
history and on Admin → Study → Media Review).

## Mobile / PWA

The respondent diary (`/r/<token>`) is mobile-first and installable: open it on a phone and
"Add to Home Screen" gets a standalone app icon that reopens straight into that respondent's
diary. It precaches its static assets and shows an offline screen instead of a browser error
when the connection drops, and in-progress answers autosave to the device so a dropped
connection mid-entry doesn't lose them.
