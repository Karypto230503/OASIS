# Device Validation Checklist

Run against a real Android phone before calling MVP complete.

## Emulator validation — 2026-05-08

- [x] Debug app launched on `emulator-5554` and connected to local proxy on port `18787`.
- [x] Start Assist opened a session and sent `session.start`, `video.frame`, and `text.input`.
- [x] Gemini Flash Live returned native audio chunks as `assistant.audio` with `audio/pcm;rate=24000`.
- [x] Release APK built at `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
- [x] Signed release APK built and verified at `android/app/build/outputs/apk/release/app-release.apk`.
- [ ] Real-phone camera/audio validation completed.

## Proxy

- [ ] Proxy starts with `APP_DEV_TOKEN`, real `GEMINI_API_KEY` or `GEMINI_API_KEYS`, `GEMINI_LIVE_MODEL`, and `GEMINI_RESPONSE_MODALITY`.
- [ ] Gemini Flash Live/native-audio models use `GEMINI_RESPONSE_MODALITY=AUDIO`.
- [ ] Proxy rejects wrong dev token.
- [ ] Proxy logs metadata only.
- [ ] Proxy does not log `dataBase64`, raw audio, raw images, dev token, or Gemini key.
- [ ] Idle timeout closes Gemini session after configured delay.

## Android app

- [ ] App launches.
- [ ] TalkBack reads app title, status, mode buttons, Start Assist button, and Stop button.
- [ ] App connects to proxy on same network or through emulator host address.
- [ ] Navigation mode can be selected.
- [ ] Reading mode can be selected.
- [ ] Object/Scene mode can be selected.
- [ ] Start Assist opens a session.
- [ ] Stop closes the session.
- [ ] Text answer appears in the app when using text response modality.
- [ ] Text answer is spoken through Android TextToSpeech when using text response modality.
- [ ] Native-audio responses play through Android PCM audio playback when using audio response modality.
- [ ] Volume buttons can be pressed to interrupt/stop Gemini's audio playback.

## Hardware Button Mapping

To enable seamless launch without screen interaction:

### Samsung Devices
1. Go to **Settings > Advanced features > Side key** (or **Side button**).
2. Under **Double press** or **Press and hold**, select **Open app**.
3. Choose **Vision Assist MVP** from the list.

Now, long-pressing (or double-pressing) the power button will instantly launch the app and start silent observation.

### Other Android Devices
Settings vary by manufacturer, but typically found under **Settings > System > Gestures** or **Settings > Buttons**. Look for options to remap the Power button or add an accessibility shortcut.

## Assistive behavior

- [ ] Navigation prompt gives short actionable phrases.
- [ ] Reading prompt preserves visible wording.
- [ ] Object/Scene prompt mentions salient objects and uncertainty.
- [ ] Low-light failure produces uncertainty instead of hallucinated detail.

## Battery and privacy

- [ ] Camera and mic stop after session closes.
- [ ] No media files are created on device.
- [ ] No media files are created on proxy.
