# INICIO Expo Mobile

This is the native respondent application for the INICIO In-Home Consumption platform. It is a real Expo / React Native client, not a WebView wrapper.

The existing `mobile/` directory is the older Capacitor shell and remains in the repository for reference. New Android pilot work should use `expo-mobile/`.

## Implemented in this first native pass

- Passwordless respondent account login by OTP.
- Personal diary-link login for F2F respondents who do not have an account.
- Mobile bearer tokens stored in Expo SecureStore.
- Multi-study respondent home.
- Study overview, consent, recent diary history and study guide.
- Questionnaire rendering for text, numeric, single-select and multi-select questions.
- Skip-logic visibility for show/hide rules.
- Photo and video evidence capture/selection using Expo Image Picker.
- Local draft saving with AsyncStorage.
- Native multipart diary submission to the existing Express/MongoDB backend.
- Server-side consent gating, validation, QC, termination rules and media persistence remain authoritative on the backend.

Audio-question capture is intentionally not faked in this first pass. Audio evidence questions do not block submission, matching the web/server validation rule. Native audio recording is a follow-up capability.

## Backend API

The app talks to `/api/mobile/...` on the existing Azure App Service. The default production endpoint is:

`https://in-home-app-e8dkcnc7eefjgycv.francecentral-01.azurewebsites.net`

Override it for local/staging work:

```bash
EXPO_PUBLIC_API_URL=https://your-staging-host.example.com npx expo start
```

## Run locally

The project targets Expo SDK 57.

```bash
cd expo-mobile
npm install
npx expo install --fix
npm run typecheck
npm start
```

## Build an installable Android APK

Install and authenticate EAS once:

```bash
npm install -g eas-cli
eas login
cd expo-mobile
eas build:configure
```

Then create the pilot APK:

```bash
npm run build:apk
```

The `preview` profile in `eas.json` uses `android.buildType: apk`, so the artifact can be installed directly on Android pilot devices.

For a Play Store build later:

```bash
npm run build:aab
```

The production profile creates an Android App Bundle (`.aab`).

## Mobile authentication model

The Expo app does not reuse browser session cookies.

- Account respondents verify an OTP, then receive a random native bearer token.
- F2F/token-only respondents can exchange their existing personal `/r/:token` diary link for a mobile bearer token scoped to that enrolment.
- Only SHA-256 hashes of mobile tokens are stored in MongoDB.
- Tokens expire after 30 days by default. Set `MOBILE_TOKEN_TTL_DAYS` on Azure to change that.

## Recommended next native pass

1. Native audio recording.
2. Expo push-notification registration and reminder deep links.
3. Join-code/deep-link onboarding directly inside the app.
4. Persisted evidence drafts for stronger offline media capture.
5. Automated API and Expo type/build checks in CI.
6. Final app icon/splash assets and EAS project ID before pilot distribution.
