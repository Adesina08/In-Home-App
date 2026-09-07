# Research platform implementation

Scope authorized: all audit recommendations except WhatsApp diary completion and reminder orchestration. Existing logo theme and inline study media remain.

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

Validation on 2026-09-06:
- `node --test tests/*.test.js`: 36 tests passed. Includes offline queue restart with disk-backed adapters, multipart retry, private media ownership, profile gating, closed-study capture, report calculations and checksum-verified local restore.
- `npm run build`: passed.
- `cd expo-mobile && npm run typecheck`: passed.
- Isolated browser checks: research workspace, admin dashboard, AI summary, questionnaire builder, interviewer dashboard, client dashboard, client analysis and approved reports at 1440px and 390px; no page overflow, browser script errors or automated WCAG A/AA violations on those pages.
- Isolated browser workflow: assignment, household visit, configured screener/consent registration, training, practice prerequisite enforcement, handover, incentive eligibility, snapshot approval and client grants. A submitted practice record was inserted as a test fixture; this does not verify physical-device capture.

Release verification still required:
- [ ] Physical Android/iOS capture, offline restart and eventual upload against the intended deployment, including camera/audio permission flows
- [ ] Live MongoDB/Azure connectivity, private recording playback and provider-specific failure recovery
- [ ] Managed database backups, media versioning, an isolated production restore drill and external availability monitoring
- [ ] Study owner review of KPI methodology, consent/screener wording, incentive amounts, retention periods, question loops and minimum bases

No incentive amounts, retention periods, volume conversions or reporting schedules are invented. Study administrators configure them. External delivery and production infrastructure are not claimed as verified by these local checks. See RESEARCH_OPERATIONS.md for operating instructions and implementation boundaries.
