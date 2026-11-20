# Vision Assist MVP

Android-first assistive AI prototype for blind and low-vision users. The phone streams camera and microphone input to a local Node.js proxy, the proxy connects to Gemini Live, and spoken Bengali audio responses play back on Android.

> Prototype status: the end-to-end Android → proxy → Gemini Live → Android loop is implemented. Some reliability work remains around long sessions, Gemini session closures, and barge-in tuning.

## What it does

- Android app with three modes: Navigation, Reading, and Object / Scene.
- Camera frames are sent to the proxy as JPEG payloads.
- Microphone audio is streamed as `audio/pcm;rate=16000`.
- Proxy connects to Gemini Live and supports key rotation through `GEMINI_API_KEYS`.
- Gemini audio responses are forwarded as `audio/pcm;rate=24000` and played by the Android app.
- Proxy-side metadata logs help debug session lifecycle without logging secrets.

## Architecture

```text
Android Kotlin app
  ├─ CameraX frame capture
  ├─ AudioRecord microphone streaming
  ├─ WebSocket client
  └─ PCM audio playback
        ↓
Node.js / TypeScript WebSocket proxy
  ├─ App event validation
  ├─ Gemini Live session manager
  ├─ Gemini API key rotation
  └─ metadata logging
        ↓
Gemini Live API
```

See [`docs/hackathon-submission.md`](docs/hackathon-submission.md) for diagrams, event flow, video script, and submission notes.

## Repository layout

```text
android/   Android Kotlin app
proxy/     Node.js / TypeScript Gemini Live proxy
docs/      validation notes and hackathon submission materials
```

## Requirements

- Android Studio or Android Gradle tooling
- Android device with camera, microphone, and wireless or USB ADB
- Node.js 22+
- Gemini Live API key(s)

## Proxy setup

```bash
cd proxy
npm install
cp .env.example .env
```

Edit `proxy/.env` locally with your own values:

```env
PORT=18787
APP_DEV_TOKEN=change-me-dev-token
GEMINI_API_KEYS=replace-with-server-side-key-1,replace-with-server-side-key-2
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_RESPONSE_MODALITY=AUDIO
SESSION_IDLE_MS=60000
```

Never commit real `.env` files or API keys.

Run the proxy:

```bash
npm run dev
```

## Android setup

For local device testing, the debug build points at the proxy through ADB reverse:

```bash
adb reverse tcp:18787 tcp:18787
```

Build and install:

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Then open the app, grant camera and microphone permissions, and tap **Start Assist**.

## Verification

Proxy:

```bash
cd proxy
npm test -- --run
npm run build
```

Android:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

## Known limitations

- This is a prototype, not a production accessibility device.
- Gemini Live sessions can close or reject keys; the proxy logs these failures and rotates keys where possible.
- Barge-in and echo suppression are still being tuned for phone speaker + microphone feedback.
- Long unattended sessions need more lifecycle hardening.
- No user account system, cloud deployment, or production auth is included.

## Security notes

- Gemini API keys live only in the proxy environment.
- Android does not embed Gemini credentials.
- `.env`, build outputs, GSD artifacts, agent scratch files, and local worktrees are ignored.

## License

No license selected yet. Add one before public reuse.
