# Interviewer portal redesign

Implemented September 6, 2026 using the existing Inicio Diary logo and blue/indigo theme.

## Experience

- Shared responsive navigation and page styling across the respondent dashboard, registration, handover, activation, held registration, bulk upload/review/result and unavailable-page states.
- One respondent roster replaces the duplicated lists. Search matches name, code and contact; filters narrow by study and status. Recruitment holds have a distinct Review needed state and action.
- Counts distinguish all registrations, registrations today in UTC, currently active respondents and pending setup. Completed respondents are not counted as pending. Practice registrations remain visibly labelled.
- Registration uses three sections: eligibility and consent, respondent details, and handover preparation. The practice checkbox accurately describes a practice respondent. Missing-field errors retain entered values and the consent wording.
- QR handover and copy-link feedback work without opening a respondent's diary on the interviewer device. A recruitment hold displays its reasons instead of a QR. Unconfigured messaging is clearly identified and the send action is not offered in that state.
- Shared bulk-invitation templates select the new shell only on interviewer routes; admin routes retain their existing shell and actions.

## Supporting fixes

Registration now rejects unavailable studies, absent approved consent wording and empty name/contact fields before writing a respondent. Recruitment identity checks use the same canonical contact stored on the registration, so local-format numbers match their international equivalents. Respondent ownership checks remain in place; superadmins can use the same support view as admins.

## Validation

- `npm run build` passed; existing Browserslist freshness warning only.
- `node --test tests/interviewerPortal.test.js tests/studyReport.test.js tests/consoleQc.test.js`: 15 tests passed, including four interviewer workflow tests.
- 11 affected EJS templates compiled.
- Browser checks at 1440px and 390px covered roster, handover, registration, activated, held, bulk upload, bulk review, bulk result and unavailable states. No page overflow or browser JavaScript errors. Targeted axe WCAG A/AA checks reported no violations.
- Search reset, copy feedback, registration success, duplicate-registration hold and CSV upload/review exercised in an isolated sample database. The bulk-result screen was tested with a rendering fixture. No invitation messages were sent and live provider delivery was not tested.

The local preview is served at `/interviewer` on port 3105 with the isolated sample database. Native Expo screens are outside this web-portal change.
