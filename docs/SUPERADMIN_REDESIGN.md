# Superadmin console redesign

The Superadmin workspace uses the existing `public/icons/logo-header.png` and its sky-blue, steel-blue, and indigo palette. White navigation and content surfaces sit on a pale blue-grey canvas. The styles are loaded only for the Superadmin role.

## Screens and workflows

- Platform Overview: study portfolio, all-time platform totals, open flags by study, and workspace shortcuts. Permanent deletion retains its existing confirmations in an expandable advanced-management section.
- Studies: portfolio table, status filters, search, pagination, and an accessible study-creation dialog.
- Fieldwork Dashboard: selected-study counts, submission share with an explicit denominator, current recruitment stages, risk, recent activity, interviewer performance, and existing CSV exports.
- Quality Control: study/status selection, flag queue, evidence and recorded answers, and reviewed/resolved decisions with notes. Evidence is checked against both the selected study and respondent before loading.
- Respondents: searchable participant lists, expandable invitation tools, profiles with account/QC tools alongside diary history, and existing QR and export actions.
- Media Review: photo/video/audio gallery, filters, file-load failures, provider status, entry links, and existing processing actions.
- Study configuration: consistent study navigation, questionnaire/skip-logic/brand panels, both questionnaire editors, upload/import review, respondent preview, consent versions, KPIs, and section navigation for settings with an unsaved-change warning.
- Team and administration: searchable users, user-creation dialog, message-log search, follow-up workflows, and system settings.
- Bulk invitation upload/review/completion and Help use the shared console shell. Bulk-invitation links retain the admin study route for Superadmins.

The console does not overwrite the theme preference used by other roles. Existing form field names and operations are retained. Search/pagination preferences are saved per route in session storage; table search only filters the records delivered by the server. Panel invitation buttons show the number of selected profiles, including selections on other pages.

## Related corrections

- Refresh reloads the selected fieldwork dashboard.
- Recent activity excludes flags belonging to another study and distinguishes non-submitted records.
- Study Settings accepts the existing percentage defaults; `min=1, step=5` previously rejected values such as 85 and 90. The field now accepts integer percentages.
- Superadmins enter the platform overview after sign-in/password replacement.

## Validation

Run from the project root:

```bash
npm run build
node --test tests/consoleQc.test.js
git diff --check
```

Browser validation used an isolated local sample database, with the scheduler disabled and deployment environment configuration excluded:

- 23 screens checked at 1440px and 390px, plus questionnaire import review and bulk roster review/completion.
- Study/user creation, filters, pagination, back-navigation state, settings persistence, unsaved-change handling, QC review/resolution, questionnaire upload/commit, mobile navigation and dialogs, CSV exports, and role restrictions exercised.
- WCAG A/AA automated checks passed on Overview, Studies, QC, Users, Study Settings, and the main questionnaire editor. This is a targeted automated check, not a full accessibility certification.
- QC regression tests cover study/respondent isolation, zero values, unanswered and historical questions, AI provenance, and empty evidence.

Media rendering was checked with a controlled local image fixture and unavailable-file states. Production database behaviour, remote media playback, external AI/messaging providers, and deployment were not exercised. No live messages were sent.
