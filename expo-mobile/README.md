# INICIO native mobile app

`expo-mobile/` is the current respondent and interviewer app. `mobile/` is the legacy Capacitor web wrapper. Both the manual APK workflow and Azure deployment now build this native project from the same source revision.

The respondent chooses **Standard** or **Video** when starting an entry. Standard renders the study questionnaire and records photo/audio/video evidence as configured. Video displays the study prompts over an in-app front camera, with automatic pacing, Previous/Next controls, a recording timer and playback/retake before submission. Pausing prompts does not pause recording. The limit is 90 seconds. Camera and microphone permissions are required. The recording is saved to app-owned storage for recovery, then copied into the durable submission queue before upload. An unfinished recording interrupted before the camera returns a file cannot be recovered.

Account OTP and personal diary-link login, the baseline profile, study consent, training/practice, interviewer assignments, and the submission queue remain part of the current app. The logo palette and native screen layouts are preserved.

## Development

```bash
cd expo-mobile
npm ci
npm run typecheck
npm start
```

`EXPO_PUBLIC_API_URL` selects the backend. The default is the existing Azure App Service. Initial authentication and initial study/script download need connectivity. The camera teleprompter is for the installed native app; a browser preview cannot verify Android camera recording.

## Downloadable Android release

Run **Build Android APK** in GitHub Actions on the intended source branch. It uses the existing repository `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` secrets. No Expo account or EAS project is needed for this workflow.

```bash
gh workflow run build-android-apk.yml --repo Adesina08/In-Home-App --ref YOUR_BRANCH
```

The workflow prebuilds Expo, bundles the JavaScript into a signed release APK, verifies its signature and embedded bundle, and uploads `inicio-diary-apk`. That artifact contains `inicio-diary.apk` and `inicio-diary.json` with version, source revision and SHA-256. Azure deployment consumes the same artifact and serves both under `/public/downloads/`. An `ANDROID_APK_URL` override must also point at the intended new release; unset a legacy override to use the bundled artifact.

Application ID remains `com.inicio.inhome`; version name is 2.0.0 and CI generates an increasing version code across both workflows. The prior Azure workflow distributed a debug-signed web wrapper. Android only accepts an in-place update when the signing certificate matches. An installed debug wrapper may require a separate migration/reinstall; preserve pending local data first. Do not rotate the existing release key.

Local release builds require Java, the Android SDK and the same signing environment variables (`ANDROID_KEYSTORE_FILE` is the local key path). Then use `npm run build:apk` or `npm run build:aab`. Generated Android/iOS projects, credentials and APKs are ignored by Git.

## Release checks

Verify the generated APK on a physical Android device: Standard/Video selection, camera/microphone denial and recovery, readable prompts during recording, manual and automatic prompt controls, playback, retake, interrupted capture, saved-recording restart, offline submission and retry. Compare the downloaded APK SHA-256 with its sidecar manifest. Type checking and Metro bundle generation do not prove device recording works.

Camera API reference: https://docs.expo.dev/versions/latest/sdk/camera/
