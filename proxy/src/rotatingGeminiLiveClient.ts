import type {
  GeminiLiveClient,
  GeminiLiveSession,
  GeminiLiveSessionHandlers,
  GeminiSetupOptions,
} from './geminiLiveClient.js';
import { WebSocketGeminiLiveClient } from './geminiLiveClient.js';

const DEFAULT_COOLDOWN_MS = 60_000;
const COOLDOWN_TOKENS = [
  'quota',
  'rate',
  'limit',
  'resource_exhausted',
  '429',
  'denied access',
  '1008',
  'permission_denied',
  'permission-denied',
  'permission denied',
  '403',
  'policy_violation',
  'policy-violation',
  'policy violation',
];

export interface RotatingGeminiLiveClientOptions {
  cooldownMs?: number;
  now?(): number;
  createClient?(apiKey: string): GeminiLiveClient;
}

export class RotatingGeminiLiveClient implements GeminiLiveClient {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly createClient: (apiKey: string) => GeminiLiveClient;
  private readonly cooledUntilByKey = new Map<string, number>();
  private nextIndex = 0;

  constructor(
    private readonly apiKeys: string[],
    options: RotatingGeminiLiveClientOptions = {},
  ) {
    if (apiKeys.length === 0) {
      throw new Error('RotatingGeminiLiveClient requires at least one API key');
    }

    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.createClient = options.createClient ?? ((apiKey) => new WebSocketGeminiLiveClient(apiKey));
  }

  connect(options: GeminiSetupOptions, handlers: GeminiLiveSessionHandlers): GeminiLiveSession {
    const replayMessages: Array<(session: GeminiLiveSession) => void> = [];
    const attemptedKeys = new Set<string>();
    let currentApiKey: string | undefined;
    let currentSession: GeminiLiveSession | undefined;
    let closed = false;
    // Tracks the last message sent so it can be replayed on the next session after a cooldown close
    let lastMessage: ((session: GeminiLiveSession) => void) | undefined;
    // Track sent media so the wrapper itself behaves like a session (for test inspection)
    const texts: string[] = [];
    const videoFrames: string[] = [];
    const audioChunks: string[] = [];

    const retry = (apiKey: string, closeCurrent: boolean, replayLast: boolean): boolean => {
      this.coolApiKey(apiKey);

      // On cooldown close: reset attempted keys so previously tried keys can be retried on the new session
      if (replayLast) {
        attemptedKeys.clear();
      }

      // Capture the last message so it can be replayed to the new session
      if (replayLast && lastMessage) {
        replayMessages.push(lastMessage);
      }
      lastMessage = undefined;

      const previousSession = currentSession;
      currentApiKey = undefined;
      currentSession = undefined;
      if (closeCurrent) {
        previousSession?.close();
      }

      return connectDelegate();
    };

    const connectDelegate = (): boolean => {
      const apiKey = this.selectApiKey(attemptedKeys, attemptedKeys.size === 0);
      if (!apiKey) {
        return false;
      }

      attemptedKeys.add(apiKey);
      const client = this.createClient(apiKey);
      currentApiKey = apiKey;
      const session = client.connect(options, {
        onEvent: (event) => {
          if (closed || currentApiKey !== apiKey) {
            return;
          }

          if (event.type === 'error' && isCooldownSignal(event.code, event.message) && retry(apiKey, true, false)) {
            return;
          }

          handlers.onEvent(event);
        },
        onClose: (code, reason) => {
          if (closed || currentApiKey !== apiKey) {
            return;
          }

          if (isCooldownSignal(String(code), reason) && retry(apiKey, false, true)) {
            return;
          }

          handlers.onClose(code, reason);
        },
        onReady: () => {
          if (closed || currentApiKey !== apiKey) {
            return;
          }

          handlers.onReady?.();
        },
      });
      currentSession = session;
      for (const replayMessage of replayMessages) {
        replayMessage(session);
        lastMessage = replayMessage;
      }
      replayMessages.length = 0;
      return true;
    };

    connectDelegate();

    const sendOrReplay = (replayMessage: (session: GeminiLiveSession) => void): void => {
      if (!currentSession && attemptedKeys.size === this.apiKeys.length) {
        attemptedKeys.clear();
        connectDelegate();
      }

      if (currentSession) {
        replayMessage(currentSession);
        lastMessage = replayMessage;
      } else {
        replayMessages.push(replayMessage);
        lastMessage = replayMessage;
      }
    };

    return {
      sendText: (text) => sendOrReplay((session) => session.sendText(text)),
      sendTextWithVideoFrame: (dataBase64, text) =>
        sendOrReplay((session) => session.sendTextWithVideoFrame(dataBase64, text)),
      sendVideoFrame: (dataBase64) => sendOrReplay((session) => session.sendVideoFrame(dataBase64)),
      sendAudioChunk: (dataBase64) => sendOrReplay((session) => session.sendAudioChunk(dataBase64)),
      close: () => {
        closed = true;
        currentSession?.close();
      },
    };
  }

  private selectApiKey(excludedKeys = new Set<string>(), allowCoolingFallback = true): string | undefined {
    const now = this.now();

    for (let attempt = 0; attempt < this.apiKeys.length; attempt += 1) {
      const index = (this.nextIndex + attempt) % this.apiKeys.length;
      const apiKey = this.apiKeys[index];
      const cooledUntil = this.cooledUntilByKey.get(apiKey) ?? 0;

      if (!excludedKeys.has(apiKey) && cooledUntil <= now) {
        this.nextIndex = (index + 1) % this.apiKeys.length;
        return apiKey;
      }
    }

    if (!allowCoolingFallback) {
      return undefined;
    }

    const fallback = this.selectEarliestCoolingKey(excludedKeys);
    if (!fallback) {
      return undefined;
    }
    this.nextIndex = (this.apiKeys.indexOf(fallback) + 1) % this.apiKeys.length;
    return fallback;
  }

  private selectEarliestCoolingKey(excludedKeys: Set<string>): string | undefined {
    let fallback: string | undefined;
    let earliestCooledUntil = Number.POSITIVE_INFINITY;

    for (const apiKey of this.apiKeys) {
      if (excludedKeys.has(apiKey)) {
        continue;
      }

      const cooledUntil = this.cooledUntilByKey.get(apiKey) ?? 0;
      // Only consider keys that are actually in cooldown; never fall back to a key
      // that was just attempted (failed) but not yet cooled
      if (cooledUntil > this.now() && cooledUntil < earliestCooledUntil) {
        fallback = apiKey;
        earliestCooledUntil = cooledUntil;
      }
    }

    return fallback;
  }

  private coolApiKey(apiKey: string): void {
    this.cooledUntilByKey.set(apiKey, this.now() + this.cooldownMs);
  }
}

function isCooldownSignal(...values: string[]): boolean {
  const haystack = values.join(' ').toLowerCase();
  return COOLDOWN_TOKENS.some((token) => haystack.includes(token));
}