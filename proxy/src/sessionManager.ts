import { randomUUID } from 'node:crypto';

import type { AppMode, ProxyEvent } from './events.js';
import type { GeminiLiveClient, GeminiLiveSession, GeminiResponseModality } from './geminiLiveClient.js';
import { buildInstruction } from './prompts.js';

export type SessionState = 'opening' | 'active' | 'cooldown' | 'closed';

export interface SessionManagerOptions {
  geminiClient: GeminiLiveClient;
  model: string;
  responseModality: GeminiResponseModality;
  idleMs: number;
  emit(event: ProxyEvent): void;
}

export class SessionManager {
  readonly sessionId = randomUUID();

  private state: SessionState = 'closed';
  private mode: AppMode = 'object';
  private geminiSession: GeminiLiveSession | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionId = 0;
  private latestVideoFrame: string | undefined;
  private speakingUntilMs = 0; // suppress mic input while assistant is speaking

  constructor(private readonly options: SessionManagerOptions) {}

  start(mode: AppMode): void {
    this.mode = mode;
    if (this.geminiSession && (this.state === 'active' || this.state === 'opening')) {
      // Session already live — just update mode and re-arm idle timer
      this.options.emit({ type: 'session.ready', sessionId: this.sessionId, mode: this.mode });
      this.armIdleTimer();
      return;
    }
    this.replaceSession(true);
    this.armIdleTimer();
  }

  updateMode(mode: AppMode): void {
    this.mode = mode;
    this.replaceSession(false);
    this.options.emit({ type: 'mode.confirmed', mode });
    this.armIdleTimer();
  }

  sendText(text: string): void {
    const session = this.ensureGeminiSession();
    const frame = this.latestVideoFrame;
    this.latestVideoFrame = undefined;
    if (frame) {
      session.sendTextWithVideoFrame(frame, text);
    } else {
      session.sendText(text);
    }
    this.armIdleTimer();
  }

  sendVideoFrame(dataBase64: string): void {
    this.latestVideoFrame = dataBase64;
    // Also stream directly to Gemini as realtimeInput for continuous vision
    if (this.geminiSession) {
      this.geminiSession.sendVideoFrame(dataBase64);
    }
    this.armIdleTimer();
  }

  sendAudioChunk(dataBase64: string): void {
    // Drop mic audio while assistant is speaking to prevent echo loop
    if (Date.now() < this.speakingUntilMs) return;
    this.ensureGeminiSession().sendAudioChunk(dataBase64);
    this.armIdleTimer();
  }

  close(): void {
    this.clearIdleTimer();
    this.latestVideoFrame = undefined;
    const session = this.geminiSession;
    this.geminiSession = undefined;
    this.connectionId += 1;
    session?.close();
    this.emitClosed();
  }

  private ensureGeminiSession(): GeminiLiveSession {
    if (!this.geminiSession) {
      this.replaceSession(true);
    }

    const session = this.geminiSession;
    if (!session) {
      throw new Error('Gemini session unavailable');
    }

    return session;
  }

  private replaceSession(emitLifecycleEvents: boolean): void {
    const existingSession = this.geminiSession;
    this.geminiSession = undefined;
    this.connectionId += 1;
    existingSession?.close();

    const currentConnectionId = this.connectionId;

    if (emitLifecycleEvents) {
      this.emitStatus('opening');
    } else {
      this.state = 'opening';
    }

    const session = this.options.geminiClient.connect(
      {
        model: this.options.model,
        instruction: buildInstruction(this.mode),
        responseModality: this.options.responseModality,
      },
      {
        onEvent: (event) => {
          if (currentConnectionId === this.connectionId) {
            // Track when assistant is speaking — suppress mic for 2s after last audio chunk
            if (event.type === 'assistant.audio') {
              // Extend suppression window with each chunk — allows barge-in 500ms after last chunk
              this.speakingUntilMs = Date.now() + 500;
            }
            if (event.type === 'assistant.turn_complete') {
              // After turn ends, suppress for extra 1.5s to let speaker drain
              this.speakingUntilMs = Math.max(this.speakingUntilMs, Date.now() + 1500);
            }
            this.options.emit(event);
          }
        },
        onClose: (code, reason) => {
          if (currentConnectionId === this.connectionId) {
            this.geminiSession = undefined;
            this.clearIdleTimer();
            this.options.emit({
              type: 'error',
              code: 'gemini_session_closed',
              message: `Gemini session closed: ${code}${reason ? ` ${reason}` : ''}`,
            });
            this.emitClosed();
          }
        },
        onReady: () => {
          if (currentConnectionId !== this.connectionId) return;
          if (emitLifecycleEvents) {
            this.emitStatus('active');
            this.options.emit({ type: 'session.ready', sessionId: this.sessionId, mode: this.mode });
          } else {
            this.state = 'active';
          }
        },
      },
    );

    this.geminiSession = session;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.close();
    }, this.options.idleMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private emitStatus(state: SessionState): void {
    this.state = state;
    this.options.emit({ type: 'status.update', state });
  }

  private emitClosed(): void {
    this.emitStatus('closed');
  }
}
