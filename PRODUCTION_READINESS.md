# Production Readiness Runbook — INICIO In-Home Consumption App

This app is a **working functional prototype**: every P0 flow in the MVP spec runs end to end (onboarding, diary engine, QC, reminders, dashboards, export), the Developer/Config console means none of the business inputs are hardcoded, a questionnaire can be uploaded from a spreadsheet or document and previewed before it's committed, the respondent diary offers three entry methods (Standard Form, AI-assisted Video, and Voice Note), and the whole app — including the respondent diary — is an installable mobile PWA with one consistent visual design system.

**As of this revision, three of the AI providers (Azure AI Vision for brand detection + video field pre-fill, Azure AI Speech for voice-note transcription) and pluggable media storage (local disk or Azure Blob Storage) have real, working implementations** — not stubs. They stay off (`*_PROVIDER=mock`, `STORAGE_PROVIDER=local`) until you supply real Azure credentials; flip the env vars documented in B9/B10 below and they call the real Azure APIs. What's still genuinely pending is everything that needs an account, a domain, or an organizational decision this sandbox cannot make on your behalf: real WhatsApp credentials (B1), a real domain + TLS (B2), staff SSO (B3), a managed production database (B4), a real secrets vault (B5), backups (B6), a written retention policy (B7), and monitoring (B8).

A companion document, the **Azure Deployment Runbook**, walks through provisioning every Azure resource this app can use (App Service hosting, AI Vision, AI Speech, Blob Storage, Key Vault) end to end with exact Portal steps and CLI commands, sized to fit an Azure free-account $200/30-day credit. This document (PRODUCTION_READINESS.md) stays focused on *what* needs doing and *where in the code* it plugs in; the runbook is the *how* for the Azure-specific pieces.

Nothing below can be completed by an AI session in a sandbox without your credentials — each item needs a real account, a real domain, or a real organizational decision. What's provided is the hookup point: the file to edit and the shape of the value it expects.

---

## B1 — Real WhatsApp Business credentials & approved templates

**Where it plugs in:** `lib/whatsapp.js` defines a provider interface with a `MockWhatsAppProvider` (current default — logs every "send" to the `whatsapp_outbox` table, visible at Admin → WhatsApp Outbox, nothing actually sent) and a `MetaCloudApiProvider` stub that is *not yet implemented* — it throws until you fill it in.

**What you need to do:**
1. Register/confirm your WhatsApp Business Platform account (Meta Cloud API, or a BSP like Twilio/360dialog) and get the message templates approved by Meta — this alone can take days, start it in Week 1 per the original Day-1 dependency list.
2. Set in `.env`: `WHATSAPP_PROVIDER=meta_cloud_api`, `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAMESPACE`.
3. Implement the actual API call inside `MetaCloudApiProvider.send()` in `lib/whatsapp.js` (currently a labeled stub) using your provider's send-template-message endpoint.
4. Until this is done, keep `WHATSAPP_PROVIDER=mock` — reminders and QC still run correctly, they just log instead of sending.

## B2 — Domain + HTTPS/TLS

The app currently runs as plain HTTP on localhost. Before any respondent or staff traffic touches it:
1. Deploy behind a reverse proxy or platform that terminates TLS (e.g., nginx + Let's Encrypt, or a managed platform like Azure App Service with a certificate attached — see the Azure Deployment Runbook for the App Service + custom-domain path).
2. Point a real domain (e.g. `pilot.yourorg.com`) at it.
3. Set `NODE_ENV=production` in the app's environment once TLS is confirmed working end-to-end — `server.js` already reads this and turns on `trust proxy` plus the `secure` session-cookie flag automatically; no code change needed.

## B3 — Hardened authentication / SSO for staff roles

Current auth is email + bcrypt password + server session — fine for a sandbox demo, not for staff handling respondent PII.
1. For an internal team, the fastest hardening is enforcing strong password policy + short session lifetime (already 8h in `server.js`) + rate-limiting the `/login` route (add `express-rate-limit`).
2. For real SSO, integrate an OIDC/SAML provider (Okta, Azure AD, Google Workspace) in front of `routes/auth.js` — replace the password check with an OIDC redirect flow and keep the same `req.session.user = {...}` shape so the rest of the app (which only reads `req.session.user.role` / `.study_id`) doesn't need to change.
3. Respondents intentionally do **not** get a password — they use the unguessable `unique_token` link per the spec ("respondent login / unique link"). Rotate/expire tokens if a link is thought to be compromised (add an `expires_at` column and check it in `routes/respondent.js`).

## B4 — Managed database & private media storage

**Media storage — done, just needs turning on.** `lib/mediaStorage.js` is a pluggable storage layer: `STORAGE_PROVIDER=local` (default) keeps using the app's own disk exactly as before; `STORAGE_PROVIDER=azure_blob` pushes every upload to a **private** Azure Blob Storage container and serves it back only via a short-lived signed (SAS) URL generated on demand — never a permanent public link, since diary media can be identifiable. Set `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY` in `.env`. See the Azure Deployment Runbook for exact resource setup.

**Database — two honest paths, pick based on how much engineering time you have:**

- **Path A (recommended for a pilot at this budget — zero code changes).** The app already reads its SQLite file path from `DATABASE_PATH` (`lib/db.js`). Point that at Azure App Service's persisted `/home` mount (e.g. `DATABASE_PATH=/home/data/data.sqlite`) so the database survives restarts and redeploys, and turn on App Service's built-in scheduled **Backup** feature (Standard tier or above) pointed at a Storage Account. This is genuinely durable for a single-instance pilot; it does not support horizontal scaling (more than one App Service instance sharing the same database), which a pilot generally doesn't need. The Azure Deployment Runbook sets this up step by step.
- **Path B (real production — a separate, larger engineering task).** Swap SQLite for a managed Postgres instance (Azure Database for PostgreSQL Flexible Server). The SQL in this app is plain `better-sqlite3` prepared statements, not an ORM, spread across roughly 160 call sites in every route file and `lib/db.js` — a genuine data-layer rewrite (different placeholder syntax, async instead of synchronous calls, SQLite-specific functions like `datetime('now')` mapped to Postgres equivalents), not a config change. Budget this as its own scoped phase once the pilot has validated the product and you're ready to support real concurrent scale.

## B5 — Secrets management

`.env` is fine for this prototype; it is **not** fine for production. Move `SESSION_SECRET`, `WHATSAPP_API_TOKEN`, and the database connection string into your platform's secrets manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, or even your hosting platform's encrypted env vars) so they're never committed or sitting in a plaintext file on the server.

## B6 — Backups

Once on a managed database (B4), turn on automated daily backups with point-in-time recovery, and separately back up the media storage bucket (most object storage supports versioning/replication natively). Test a restore before the pilot goes live — an untested backup is not a backup.

## B7 — Data retention policy

The schema tracks `is_practice` (excludes test data from analysis) and timestamps on every table, so retention rules are enforceable once written. What's missing is the policy itself: how long respondent PII, media, and diary data are kept after the study closes, and who approves deletion. This is a decision for your data protection/legal function, not an engineering one — write it down, then implement a scheduled job that enforces it.

## B8 — Monitoring, logging & alerting

The app writes an `audit_log` table (who did what, when) but has no external monitoring yet. Before pilot:
1. Add structured request logging (e.g. `pino` or `morgan`) and ship logs to your platform's log aggregator.
2. Add uptime/error alerting (Sentry for exceptions, a simple uptime check hitting `/login`).
3. The reminder engine now also runs automatically on an interval (`lib/scheduler.js`, default every 15 minutes — set `REMINDER_ENGINE_INTERVAL_MINUTES` to change it, or `REMINDER_ENGINE_AUTORUN=false` to disable and go back to manual-only) in addition to the "Run Reminder Engine" button, which still works for an on-demand run. This is a single-process `setInterval`, which is fine for one App Service instance; if you ever scale to multiple instances, move it to a real external scheduler/queue worker so it isn't triggered redundantly by every instance, with alerting if a run fails or doesn't happen.

## B9 — Brand detection on photo/video evidence (Azure AI Vision) — implemented, needs a real resource

**Where it plugs in:** `lib/brandDetection.js` defines a provider interface — a `MockBrandDetectionProvider` (default; every photo/video is queued but marked `unavailable`, visible on Admin → Study → Media Review) and an `AzureVisionProvider` that **actually calls Azure AI Vision** once you supply credentials.

**What the real provider does:** for a photo, it sends the image bytes straight to Azure AI Vision's Image Analysis endpoint (`tags` + `read`/OCR); for a video, it samples up to 5 frames (via the bundled `ffmpeg-static` binary — no system ffmpeg install needed) and analyzes each. It then fuzzy-matches the detected tags/OCR text against this study's brand/SKU list (the `brands` table, editable at Admin → Study Config → Brand/SKU List) and writes the best match to `media.detected_brand`.

**What you need to do:**
1. Create an Azure AI Vision resource (the Azure Deployment Runbook has exact steps) and get its endpoint + key.
2. Set in `.env`: `BRAND_DETECTION_PROVIDER=azure_vision`, `AZURE_VISION_ENDPOINT`, `AZURE_VISION_KEY`.
3. That's it — no code changes needed. Until you do this, `BRAND_DETECTION_PROVIDER=mock` keeps detection `unavailable` for every item, exactly as before.

**Honest limits, not fixed by more configuration:** generic Image Analysis tagging reads visible **text** on packaging reasonably well via OCR; it does **not** reliably recognize a **logo** with no legible text. For real logo-level detection, train an **Azure AI Custom Vision** project on your brand logos and swap in its prediction endpoint instead — a separate, larger piece of work, not a config flip.

**Video mode reuses this same resource.** The respondent diary offers three ways to log an entry — Standard Form, Video (AI-assisted), and Voice Note. In Video mode the respondent records one video up front and `lib/videoFieldExtraction.js` (same pattern: `MockVideoFieldExtractionProvider` default, `AzureVideoFieldExtractionProvider` real) pre-fills whatever single/multi-select diary questions it can confidently match against the video's sampled frames — leaving everything else, including anything numeric like a servings count (no honest signal for that from generic tagging), for the respondent to answer. Set `VIDEO_FIELD_EXTRACTION_PROVIDER=azure_vision` — it reads the same `AZURE_VISION_ENDPOINT` / `AZURE_VISION_KEY`, no separate resource needed.

## B10 — Voice note transcription (Azure AI Speech) — implemented, needs a real resource

**Where it plugs in:** `lib/audioTranscription.js` — a `MockAudioTranscriptionProvider` (default; every voice note marked `unavailable`) and an `AzureSpeechProvider` that **actually calls Azure AI Speech's Fast Transcription REST API** (a synchronous "send audio, get text back" call — no polling needed, ideal for a short voice note) once you supply credentials. In Voice Note mode the respondent answers the diary questions manually as usual, then records a short spoken summary at the end; the recording is always attached as a QC-reviewable audio note, and this is what additionally transcribes it to text.

**What you need to do:**
1. Create an Azure AI Speech resource (Azure Deployment Runbook has exact steps) and get its key + endpoint.
2. Set in `.env`: `AUDIO_TRANSCRIPTION_PROVIDER=azure_speech`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_ENDPOINT` (copy the exact value from the resource's "Keys and Endpoint" Portal page — most reliable; `AZURE_SPEECH_REGION` works as a fallback if you only have the region).
3. That's it — no code changes needed. Until you do this, `AUDIO_TRANSCRIPTION_PROVIDER=mock` keeps transcription `unavailable` for every voice note; the recording itself is always saved and playable from Media Review either way, since it's an independent QC artifact regardless of transcription.

## B11 — Diary reminder push notifications (Web Push) — implemented and configured

**Where it plugs in:** `lib/push.js` (send/store), `public/js/push-subscribe.js` (respondent opt-in on the diary home screen), `public/sw.js` (`push` / `notificationclick` handlers), `lib/reminders.js` (sends when a study's `default_reminder_channel` is "In-app / Push" instead of WhatsApp).

**Unlike B9/B10, this needed no external account to wire up.** Web Push (the same "Allow notifications?" prompt any website can ask for) authenticates via a VAPID key pair the app generates itself — no Firebase project, no Apple Developer Program, no API to sign up for. A real key pair is already set in `.env` (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`) — **copy the same three values into Azure App Service → Configuration → Application settings** so the deployed app can send real notifications (they're not secret the way an API key to a paid service is, but treat `VAPID_PRIVATE_KEY` like any other credential — rotating it invalidates every respondent's existing subscription, so only do that if it actually leaks).

**How it behaves:** the first time a respondent opens their diary (past consent), they see a small "Enable reminders" card — accepting triggers the real browser permission prompt and subscribes that device. The reminder engine (B8, now running automatically) sends a push to every device a respondent has enabled reminders on whenever they're due/missed per the study's Reminder Schedule settings (Admin → Study Config → Settings). A respondent who denies or dismisses the prompt is never nagged again (respected, not retried), and a device that later reports its subscription as gone is pruned automatically.

**Known limits:**
- This reaches an installed/home-screen **PWA or a browser tab** left open or reopened — the standard web platform mechanism. It does **not** reach the Capacitor-wrapped native app shells in `mobile/` — those load the same site in a plain WebView, which has no access to the browser's push service. Real push into the App Store/Play Store app specifically would need `@capacitor/push-notifications` wired to Firebase Cloud Messaging (Android) and an APNs key (iOS), both of which require accounts only you can create, plus a native rebuild — a separate, larger piece of work if the store apps specifically (not just the installed PWA) need this.
- iOS Safari only supports web push for a PWA actually added to the home screen (iOS 16.4+), not for a regular Safari tab — respondents on iPhone need to use "Add to Home Screen" (the QR code flow already in Admin → Respondents does this) for reminders to reach them.
- The due/missed timing is relative to each respondent's own last entry (Admin → Study Config → Reminder Schedule: "due after X hours" / "missed after Y hours"), not a fixed clock time — e.g. "due after 24 hours" fires whenever it's actually been 24 hours since their last entry, whatever time of day that is. If you'd rather notify everyone at fixed times of day (e.g. always 9am and 8pm) instead, that's a different, fairly small follow-up change to `lib/reminders.js` and the study settings, not implemented here.

---

## C — Release Validation (needs a real environment and human stakeholders)

These cannot be done in this sandbox — they need the real deployment from tier B, real respondent volumes, and people:

- **C1 — Performance/load testing at expected respondent volume.** Once deployed on the real stack, run a load test (k6, Artillery, or similar) simulating expected concurrent respondents submitting diaries with photo uploads, at peak reminder-driven traffic. Watch database connection limits and media upload throughput specifically.
- **C2 — Privacy/security review.** Have your security/legal function review data flows, the consent wording (Developer → Consent Wording), access controls, and the retention policy (B7) before go-live. A penetration test of the deployed instance is standard practice for anything handling PII.
- **C3 — Stakeholder UAT.** Walk the client/research stakeholders through every role (this runbook's companion screenshots are a starting point) on the real deployed environment, not this prototype.
- **C4 — Fix all critical/high UAT defects.** Standard defect-triage: nothing critical/high stays open at pilot launch, per the MVP Definition of Done.
- **C5 — Formal pilot acceptance / sign-off.** A named sign-off (client + research lead) against the Definition of Done checklist delivered with the project plan, dated and recorded — this is what makes launch official, not a green build.

---

## Quick reference — where each piece of config lives in the code

| Need | File |
|---|---|
| WhatsApp provider | `lib/whatsapp.js`, `.env` |
| Session/auth | `server.js` (session config), `routes/auth.js`, `lib/auth.js` |
| Database connection & schema | `lib/db.js` |
| Photo upload storage | `routes/respondent.js` (multer config), `server.js` (`/uploads` static route) |
| Reminder scheduling | `lib/reminders.js`, auto-run every interval by `lib/scheduler.js` (also callable on demand from `routes/admin.js` `/reminders/run`) |
| Push notifications | `lib/push.js`, `public/js/push-subscribe.js`, `public/sw.js`, VAPID keys in `.env` |
| QC rule thresholds | Set per-study via Admin → Study Config → Settings & Thresholds (no code change needed) |
| Questionnaire, skip logic, brands, consent, KPIs | All configurable via Admin → Study Config (Developer/Config console) — no code change needed |
| Questionnaire spreadsheet/document import | `lib/questionnaireParser.js`, `routes/admin.js` (`/questionnaire/upload`, `/questionnaire/preview/:id`) |
| Brand detection provider | `lib/brandDetection.js`, `lib/azureVisionClient.js`, `.env` (B9) |
| Video-mode field-extraction provider | `lib/videoFieldExtraction.js`, `.env` (B9) |
| Voice-note transcription provider | `lib/audioTranscription.js`, `.env` (B10) |
| Video-frame sampling (for the two providers above) | `lib/ffmpegFrames.js` (bundled `ffmpeg-static` binary, no system install needed) |
| Media storage (local disk or Azure Blob) | `lib/mediaStorage.js`, `.env` (`STORAGE_PROVIDER`, B4) |
| Diary entry-mode picker (Standard / Video / Voice Note) | `routes/respondent.js` (`/diary/new`, `/diary/analyze-video`), `views/respondent/diary_mode_picker.ejs` |
| PWA manifest / service worker / icons | `public/manifest.json`, `public/sw.js`, `public/icons/`, per-respondent manifest in `routes/respondent.js` (`/:token/manifest.json`) |
| Visual design system (tokens, icons, component conventions) | `DESIGN_SYSTEM.md`, `tailwind.config.js`, `lib/icons.js` |
| Crash-proofing for async route handlers | `server.js` (`express-async-errors` + global error middleware + `process.on` safety nets) |
| Azure resource provisioning + hosting | **Azure Deployment Runbook** (separate document) |
