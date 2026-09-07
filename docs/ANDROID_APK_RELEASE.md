# Native APK release verification

Verified build: INICIO Diary 2.0.0, Android version code 21509795.

- Source revision: `6ef48ea13bf2463f66dd65ba45b9eaa6decfa36c`
- Source branch: `fix/native-apk-teleprompter`
- Build: https://github.com/Adesina08/In-Home-App/actions/runs/34063831729
- APK size: 66,209,169 bytes
- SHA-256: `d763b844f379685395d46812c26e94f2ab33ba546ff0eb31c98ea0a53f787122`
- Local download: `public/downloads/inicio-diary.apk`
- Metadata: `public/downloads/inicio-diary.json`

The signed release build passed. Its checksum matches the metadata, `assets/index.android.bundle` is present, and `assets/capacitor.config.json` is absent. The published legacy APK was inspected separately and confirmed to be an Android-debug-signed Capacitor wrapper. No live replacement is claimed by this verification record.

The native app retains the Standard/Video entry choice. Video now uses an in-app camera with visible questionnaire prompts, adjustable automatic pacing, manual Previous/Next controls, a 90-second timer, playback and retake. A completed recording is persisted before upload. Submission failures retain it; successful queueing allows cleanup of the recording draft.

Validation:
- Native TypeScript passed locally and in GitHub Actions.
- Metro generated the Android JavaScript bundle.
- All 36 backend/queue regression tests passed.
- A React component check with mocked camera/video hardware verified visible prompts while recording, prompt navigation/pause, playback, persisted draft restoration after remount, preservation on queue failure, and cleanup after successful queueing.
- Physical-device camera, microphone, playback and installation tests remain outstanding.

Release transition: package ID remains `com.inicio.inhome`. Android cannot replace an installed APK signed with a different certificate. Devices using the debug build may require reinstalling; protect unsynced entries before removing that app. Use the established release key for all subsequent builds. The matching backend changes must accompany this native release.
