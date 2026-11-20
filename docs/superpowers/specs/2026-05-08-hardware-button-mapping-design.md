# Hardware Button Mapping & Semantic Routing Spec

## Overview
This feature redesigns the core interaction model of the Vision Assist app to be primarily hardware-button and voice-driven, removing the need for screen interaction for blind users. It introduces power button app launching, volume button barge-in (interruption), and semantic voice-based routing to replace manual UI mode switching.

## User Experience Flow
1. **Idle State**: Device is asleep or on the home screen.
2. **Launch**: User long-presses the Power button. This triggers the app to open.
3. **Silent Observation**: The app immediately connects to the Gemini Live API and starts streaming camera frames. Gemini processes these frames silently. It does *not* speak yet.
4. **Instruction & Routing**: User speaks an instruction (e.g., "Read this sign", "What's in front of me?", "Guide me to the door").
5. **Action**: Gemini semantically understands the request, implicitly switches to the correct mode (Reading, Object Detection, Navigation), and responds with audio.
6. **Barge-in (Interruption)**: While Gemini is speaking, if the user clicks any Volume button, the audio playback immediately stops. The app flushes the audio queue and actively listens for the next user instruction.

## Architecture & Implementation Details

### 1. Power Button Launch
- **Mechanism**: Leverage standard Android OS capabilities for the Power button. Samsung and other devices allow mapping long-press Power to a specific app.
- **Action Required**: Provide instructions/documentation for the user on how to map the power button to the Vision Assist app via OS settings. Ensure the app's `MainActivity` immediately initiates the camera and Gemini WebSocket connection upon launch.

### 2. Silent Observation & Semantic Routing
- **Silent Start**: When the session starts, the initial system prompt must instruct Gemini to accept video frames but remain silent until explicitly addressed by the user.
- **Unified Mode**: Remove the strict UI-based modes (`navigation`, `reading`, `object`). Instead, create a unified prompt that describes all capabilities and instructs Gemini to act based on the user's spoken intent.
- **Prompt Adjustments**: The `proxy/src/prompts.ts` will be updated to a single, comprehensive instruction set that guides Gemini on how to act when asked to read, navigate, or describe objects.

### 3. Volume Button Barge-in (Interruption)
- **Key Event Interception**: Override `dispatchKeyEvent` in `MainActivity` to intercept `KEYCODE_VOLUME_UP` and `KEYCODE_VOLUME_DOWN`.
- **Audio Flushing**: When intercepted, signal the `TtsSpeaker` / `PcmAudioPlayer` to stop playing, flush its internal `AudioTrack` buffer, and reset state.
- **Client Interruption**: Send a client-side signal to the Gemini Live session to discard any pending server audio and indicate the user is about to provide a new instruction (similar to the "client turn" or barge-in features of the Live API).

## Acceptance Criteria
- [ ] App can be launched and start streaming via a mapped Power button long-press.
- [ ] App starts silently without narrating the initial scene until spoken to.
- [ ] Gemini responds appropriately to different types of requests (reading, navigating, describing) without manual UI mode switching.
- [ ] Clicking a Volume button immediately halts Gemini's speech.
- [ ] After a Volume button click, the app successfully captures and processes the next spoken instruction.
