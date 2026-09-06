# Client reports and respondent onboarding

Implemented September 6, 2026. Uses the existing Inicio Diary logo and blue/indigo palette.

## Screens and behavior

- AI Summary now combines a period filter, saved narrative, summary history, occasion chart, word cloud and respondent media collage. Audio and video play inline with native controls; the gallery contains no source-entry links. Media filters pause hidden players. Missing files have an explicit unavailable state.
- Client portal now has Study overview and Insights & media pages, study/date filters, configured KPIs, daily submission counts, brand charts, saved summaries and a scoped aggregate CSV export.
- All 14 existing join/invite templates use the same onboarding shell, card width, typography, forms and responsive journey indicator. Three stages accommodate optional verification and returning accounts without contradictory screen totals. Consent, verification, profile, participation choice and account handlers retain their existing behavior.
- Invalid invitation and client report states use the corresponding new page design.

## Data definitions

Submitted counts include only non-practice submitted records in the selected study and inclusive date range. Answer charts and word frequencies exclude records with open entry-level QC flags and unconfirmed AI video answers. Media uses that same record eligibility. Word sizes represent token frequency across eligible text-question responses, not sentiment, unique people or inferred media transcripts. Common English words and contact/link tokens are omitted from the cloud.

Current enrollment counts are identified separately from period measures. Configured questionnaire KPIs use eligible period entries and retain their computed denominator. Completion is submissions divided by all period records. The legacy brand-incidence tile is explicitly described as distinct brand answers. Weekly occasion averages now normalize by calendar weeks within the selected dates (or first to last submission for open bounds).

Saved summaries keep their original metric and open-text snapshots. Live visuals can change after generation; the interface states this. Fixed-template narratives remain explicitly labelled as not AI-written. Summary generation now awaits metric collection and saves actual brand/occasion arrays. Clients can access only their assigned study; unassigned clients receive an unavailable state.

## Validation

- `npm run build` passes (existing Browserslist freshness warning only).
- `node --test tests/studyReport.test.js tests/consoleQc.test.js`: 11 tests pass, covering inclusive date boundaries, invalid dates, study scope, eligibility, provenance, empty states, summary persistence, inline media markup and scoped CSV export.
- 23 changed EJS templates compile.
- Browser checks at 1440px and 390px: AI Summary, both Client pages, welcome, consent, profile, About you, tutorial, participation choice, account creation, ready/download, pre-survey and unavailable join state. No horizontal overflow or browser JavaScript errors. Targeted WCAG A/AA axe checks pass after contrast fixes.
- Completed the consent-to-app-handoff path in an isolated local JSON database with OTP bypass. No real SMS, WhatsApp or AI provider was invoked.
- Separate temporary audio/video fixtures verified playback advances inline, filtering pauses hidden recordings, and the gallery has no media-source anchors. Sample seed media paths are missing files; real study files and Azure playback were not verified.

No deployment or GitHub push was performed. The local review server uses an isolated sample database; test clips are not included in the application or source data.
