# Hardware Button Mapping & Semantic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign app interaction to be primarily hardware-button and voice-driven with volume button barge-in and semantic routing.

**Architecture:** Intercept volume button key events at the `MainActivity` level to trigger audio flush. Update proxy prompts to a unified mode that enables silent observation and semantic routing based on user instruction.

**Tech Stack:** Android (Kotlin), Node.js (TypeScript), Gemini Live API

---

### Task 1: Unified Semantic Routing Prompts

**Files:**
- Modify: `proxy/src/prompts.ts`
- Modify: `proxy/src/sessionManager.ts`
- Modify: `proxy/tests/sessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in proxy/tests/sessionManager.test.ts
// Add test for unified mode or ensure mode 'object' (which will be default unified) uses unified prompt
it('uses unified instruction for object mode', () => {
    const { sessionManager, geminiClient } = createSessionManager();
    sessionManager.start('object');
    expect(geminiClient.connections[0].options.instruction).toContain('unified mode');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy npm run test -- proxy/tests/sessionManager.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// in proxy/src/prompts.ts
import type { AppMode } from './events.js';

const BASE_INSTRUCTIONS = [
  'You are concise visual assistant for blind user.',
  'Describe only useful information.',
  'Prioritize safety, orientation, readable text, and actionable observations.',
  'Be brief unless user asks for detail.',
  'Default to Bangla when user language is unclear or app asks about current scene.',
  'If user asks in English, answer in English.',
  'Do not repeat same answer in both Bangla and English unless user asks for translation.',
  'Mention uncertainty.',
  'Do not invent details you cannot see or hear.',
];

const UNIFIED_INSTRUCTION = `Unified mode: You are operating in a continuous silent observation state.
1. DO NOT speak or describe the scene until the user explicitly speaks an instruction.
2. When the user speaks, analyze their intent and respond accordingly:
   - If they ask for navigation (e.g., "guide me", "hazards"), prioritize hazards, obstacles, doors, stairs, path direction. Use short actionable phrases.
   - If they ask for reading (e.g., "read this", "what does it say"), prioritize visible text, labels, signs. Preserve exact wording.
   - If they ask for object/scene description (e.g., "what's here", "describe"), describe salient objects and context.
3. If interrupted, immediately stop your current response and wait for the next instruction.`;

export function buildInstruction(mode: AppMode): string {
  // Ignore the 'mode' argument and always return the unified instruction
  return [...BASE_INSTRUCTIONS, UNIFIED_INSTRUCTION].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy npm run test -- proxy/tests/sessionManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add proxy/src/prompts.ts proxy/tests/sessionManager.test.ts
rtk git commit -m "feat: implement unified semantic routing prompt"
```

### Task 2: PcmAudioPlayer Flush Capability

**Files:**
- Modify: `android/app/src/main/java/com/visionassist/mvp/speech/TtsSpeaker.kt`

- [ ] **Step 1: Write the failing test (manual verification via compile)**

*No automated test for audio track natively, we'll verify compilation and structure.*

- [ ] **Step 2: Write minimal implementation**

```kotlin
// in android/app/src/main/java/com/visionassist/mvp/speech/TtsSpeaker.kt
// Update AssistantAudioPlayer interface
interface AssistantAudioPlayer {
    fun playPcm24KhzBase64(dataBase64: String)
    fun stopAndFlush() // Add this method
    fun shutdown()
}

// Update PcmAudioPlayer implementation
class PcmAudioPlayer : AssistantAudioPlayer {
    private var audioTrack: AudioTrack? = null

    override fun playPcm24KhzBase64(dataBase64: String) {
        val audio = Base64.decode(dataBase64, Base64.DEFAULT)
        if (audio.isEmpty()) return
        val track = audioTrack ?: createTrack(audio.size).also {
            audioTrack = it
            it.play()
        }
        try {
            track.write(audio, 0, audio.size)
        } catch (e: IllegalStateException) {
            // Ignore write errors if flushed
        }
    }

    override fun stopAndFlush() {
        audioTrack?.let {
            try {
                it.pause()
                it.flush()
                it.play() // Ready for next writes
            } catch (e: IllegalStateException) {
                // Handle state exceptions
            }
        }
    }

    // ... rest of implementation
```

- [ ] **Step 3: Run gradle build to verify it compiles**

Run: `rtk proxy ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
rtk git add android/app/src/main/java/com/visionassist/mvp/speech/TtsSpeaker.kt
rtk git commit -m "feat: add stopAndFlush to PcmAudioPlayer"
```

### Task 3: Volume Button Interception and Barge-in

**Files:**
- Modify: `android/app/src/main/java/com/visionassist/mvp/MainActivity.kt`
- Modify: `android/app/src/main/java/com/visionassist/mvp/ui/MainViewModel.kt`

- [ ] **Step 1: Write the minimal implementation**

```kotlin
// in android/app/src/main/java/com/visionassist/mvp/ui/MainViewModel.kt
// Add interruptAudio method
fun interruptAudio() {
    audioPlayer.stopAndFlush()
    // Optional: send a 'clientContent' message to server with empty content to signal turn complete, 
    // but flushing local audio is the primary requirement for barge-in for now.
    // In Gemini Live API, starting to speak automatically interrupts, but physical button just stops audio.
}

// in android/app/src/main/java/com/visionassist/mvp/MainActivity.kt
// Add dispatchKeyEvent override
override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val action = event.action
    val keyCode = event.keyCode

    if (action == KeyEvent.ACTION_DOWN) {
        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
                // Intercept volume buttons to flush audio
                viewModel.interruptAudio()
                // Return true to consume the event so system volume doesn't change
                return true
            }
        }
    }
    return super.dispatchKeyEvent(event)
}
```

- [ ] **Step 2: Run gradle build to verify it compiles**

Run: `rtk proxy ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
rtk git add android/app/src/main/java/com/visionassist/mvp/MainActivity.kt android/app/src/main/java/com/visionassist/mvp/ui/MainViewModel.kt
rtk git commit -m "feat: intercept volume buttons for audio barge-in"
```

### Task 4: Documentation for Power Button Mapping

**Files:**
- Modify: `docs/device-validation.md` (or create new docs/user-guide.md)

- [ ] **Step 1: Write minimal implementation**

```markdown
// in docs/device-validation.md
## Hardware Button Mapping

To enable seamless launch without screen interaction:

### Samsung Devices
1. Go to **Settings > Advanced features > Side key** (or **Side button**).
2. Under **Double press** or **Press and hold**, select **Open app**.
3. Choose **Vision Assist MVP** from the list.

Now, long-pressing (or double-pressing) the power button will instantly launch the app and start silent observation.

### Other Android Devices
Settings vary by manufacturer, but typically found under **Settings > System > Gestures** or **Settings > Buttons**. Look for options to remap the Power button or add an accessibility shortcut.
```

- [ ] **Step 2: Commit**

```bash
rtk git add docs/device-validation.md
rtk git commit -m "docs: add instructions for power button mapping"
```

---

## Self-Review Checklist
- [x] Spec coverage: Power button launch (Task 4), Silent start & semantic routing (Task 1), Volume button barge-in (Task 2 & 3).
- [x] Placeholder scan: No TODOs or TBDs. All code provided.
- [x] Type consistency: `stopAndFlush` defined in Task 2 and used correctly in Task 3.
