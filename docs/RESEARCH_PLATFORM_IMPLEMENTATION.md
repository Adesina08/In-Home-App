# Research platform implementation

Scope authorized: all audit recommendations, with WhatsApp diary completion now being developed alongside the mobile app. Existing logo theme and inline study media remain.

Implemented in the local checkout:
- [x] Shared research KPI definitions, eligibility, occurrence/capture/submit/sync timestamps
- [x] Durable native mobile submissions with copied media, retry, receipt recovery, duplicate prevention and offline status
- [x] Interviewer assignments and household visits, screening, consent evidence, training, practice, handover and back-checks
- [x] Configured incentive milestones and QC-controlled hold/release ledger
- [x] Segments, cross-tabs, period comparisons, repeat/switching, approved themes and bounded research queries
- [x] Scheduled aggregate snapshots, internal alerts and approval before client publication
- [x] Advanced questionnaire rules, rotation, configured product/member loops and configurable close-out
- [x] Client media/export grants, base suppression, withdrawal, retention actions and media authorization
- [x] Read-only production configuration checks, local backup/restore tooling and operational failure logs
- [x] Automated regression tests, desktop/mobile browser checks and mobile type checking
- [x] Unified Fieldwork & Analysis dashboard with charts, response trends, crosstabs and operations controls
- [x] Superadmin-only staff/client provisioning through Resend with expiring temporary credentials
- [x] Azure OpenAI summaries with automatic stale-data refresh and manual version generation
- [x] Unified questionnaire builder with downloadable XLSX template, inline skip/termination rules, working Other-specify fields and embedded desktop/mobile preview
- [x] Country/state study scope, multi-channel reminders, redesigned consent and client KPI configuration
- [x] Superadmin bulk respondent deletion with linked data and physical-media cleanup
- [x] First WhatsApp diary slice: command-based start/status/cancel, text and structured questionnaire answers, skip/termination rules, submission, QC and analysis integration
- [x] Secure inbound WhatsApp photo/video/audio capture with trusted-host checks, authenticated bounded downloads, private storage, question linkage and AI-processing handoff
- [x] Contact/preference-aware OTP, invitation and reminder routing across Resend email, Twilio SMS and Twilio WhatsApp, with independent phone senders and shared delivery logging

WhatsApp work still in progress:
- [ ] Complete WhatsApp end-of-study validation and richer reminder-to-diary entry points
- [ ] Validate the full webhook and approved-template journey against the intended Twilio WhatsApp Business sender

Validation on 2026-09-08:
- `node --test tests/*.test.js`: 54 tests passed. Includes offline queue restart with disk-backed adapters, multipart retry, private media ownership, profile gating, closed-study capture, WhatsApp diary completion/retry/media handling, channel-aware SendGrid/Twilio delivery, report calculations, staff account delivery, inline questionnaire behaviour, bulk deletion and checksum-verified local restore.
- `npm run build`: passed.
- `cd expo-mobile && npx tsc --noEmit`: passed.
- Authenticated browser checks: merged Fieldwork & Analysis dashboard, questionnaire builder, consent, client KPIs, users, data management and AI summary rendered successfully at desktop size with no visible overlap.
- Isolated browser workflow: assignment, household visit, configured screener/consent registration, training, practice prerequisite enforcement, handover, incentive eligibility, snapshot approval and client grants. A submitted practice record was inserted as a test fixture; this does not verify physical-device capture.

Release verification still required:
- [ ] Physical Android/iOS capture, offline restart and eventual upload against the intended deployment, including camera/audio permission flows
- [ ] Live MongoDB/Azure connectivity, private recording playback and provider-specific failure recovery
- [ ] Managed database backups, media versioning, an isolated production restore drill and external availability monitoring
- [ ] Study owner review of KPI methodology, consent/screener wording, incentive amounts, retention periods, question loops and minimum bases

No incentive amounts, retention periods, volume conversions or reporting schedules are invented. Study administrators configure them. External delivery and production infrastructure are not claimed as verified by these local checks. See RESEARCH_OPERATIONS.md for operating instructions and implementation boundaries.
