import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webSocketMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const sockets: unknown[] = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly url: string) {
      sockets.push(this);
    }

    on(eventName: string, listener: Listener): this {
      const listeners = this.listeners.get(eventName) ?? [];
      listeners.push(listener);
      this.listeners.set(eventName, listeners);
      return this;
    }

    send(data: string): void {
      if (this.readyState !== MockWebSocket.OPEN) {
        throw new Error('WebSocket is not open');
      }
      this.sent.push(data);
    }

    open(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    }

    close(code = 1000, reason = ''): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    }

    fail(error = new Error('socket failed')): void {
      this.emit('error', error);
    }

    message(data: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(data)));
    }

    rawMessage(data: string): void {
      this.emit('message', Buffer.from(data));
    }

    private emit(eventName: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(...args);
      }
    }
  }

  return { MockWebSocket, sockets: sockets as MockWebSocket[] };
});

vi.mock('ws', () => ({ default: webSocketMock.MockWebSocket }));

import { loadConfig } from '../src/config.js';
import {
  WebSocketGeminiLiveClient,
  buildGeminiAudioMessage,
  buildGeminiImageTextMessage,
  buildGeminiSetupMessage,
  buildGeminiTextMessage,
  buildGeminiVideoMessage,
  extractProxyEventsFromGemini,
} from '../src/geminiLiveClient.js';
import { sanitizeLogFields } from '../src/logger.js';

beforeEach(() => {
  webSocketMock.sockets.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Gemini Live message builders', () => {
  it('builds setup message with model, instruction, and text modality', () => {
    const message = buildGeminiSetupMessage({
      model: 'models/test-live',
      instruction: 'Assist briefly.',
    });

    expect(message.setup.model).toBe('models/test-live');
    expect(message.setup.systemInstruction.parts[0]?.text).toBe('Assist briefly.');
    expect(message.setup.generationConfig.responseModalities).toEqual(['TEXT']);
  });

  it('builds setup message with audio modality', () => {
    const message = buildGeminiSetupMessage({
      model: 'models/test-live',
      instruction: 'Assist briefly.',
      responseModality: 'AUDIO',
    });

    expect(message.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
  });

  it('builds user text message with turn completion', () => {
    expect(buildGeminiTextMessage('What is ahead?')).toEqual({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text: 'What is ahead?' }],
          },
        ],
        turnComplete: true,
      },
    });
  });

  it('builds JPEG realtime input video payload', () => {
    expect(buildGeminiVideoMessage('jpeg-base64')).toEqual({
      realtimeInput: {
        video: {
          mimeType: 'image/jpeg',
          data: 'jpeg-base64',
        },
      },
    });
  });

  it('builds PCM 16 kHz realtime input audio payload', () => {
    expect(buildGeminiAudioMessage('pcm-base64')).toEqual({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: 'pcm-base64',
        },
      },
    });
  });
});

describe('WebSocketGeminiLiveClient', () => {
  it('queues user messages until Gemini setup completes', () => {
    const events: unknown[] = [];
    const closes: unknown[] = [];
    const session = new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: (event) => events.push(event),
        onClose: (code, reason) => closes.push({ code, reason }),
      },
    );

    expect(() => session.sendText('What is ahead?')).not.toThrow();
    expect(() => session.sendVideoFrame('jpeg-base64')).not.toThrow();

    const socket = webSocketMock.sockets[0];
    expect(socket?.sent).toEqual([]);

    socket?.open();

    expect(socket?.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      buildGeminiSetupMessage({ model: 'models/test-live', instruction: 'Assist briefly.' }),
    ]);

    socket?.message({ setupComplete: {} });

    expect(socket?.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      buildGeminiSetupMessage({ model: 'models/test-live', instruction: 'Assist briefly.' }),
      buildGeminiTextMessage('What is ahead?'),
      buildGeminiVideoMessage('jpeg-base64'),
    ]);
    expect(events).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('keeps queued audio until Gemini setup completes', () => {
    const session = new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: () => undefined,
        onClose: () => undefined,
      },
    );

    session.sendAudioChunk('pcm-base64');
    const socket = webSocketMock.sockets[0];
    socket?.open();

    let sentMessages = socket?.sent.map((data) => JSON.parse(data) as Record<string, unknown>) ?? [];
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toHaveProperty('setup');

    socket?.message({ setupComplete: {} });

    sentMessages = socket?.sent.map((data) => JSON.parse(data) as Record<string, unknown>) ?? [];
    expect(sentMessages[1]).toEqual(buildGeminiAudioMessage('pcm-base64'));
  });

  it('logs Gemini lifecycle and outbound metadata without raw media or secrets', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = new WebSocketGeminiLiveClient('secret-api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.', responseModality: 'AUDIO' },
      {
        onEvent: () => undefined,
        onClose: () => undefined,
      },
    );

    session.sendText('What is ahead?');
    session.sendVideoFrame('jpeg-base64');
    const socket = webSocketMock.sockets[0];
    socket?.open();
    socket?.message({ setupComplete: {} });
    socket?.close(1000, 'done');

    const logs = consoleInfo.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logs).toEqual([
      { level: 'info', message: 'Gemini WebSocket opened' },
      {
        level: 'info',
        message: 'Gemini outbound message sent',
        messageType: 'setup',
        model: 'models/test-live',
        responseModalities: ['AUDIO'],
      },
      { level: 'info', message: 'Gemini setup complete', queuedMessageCount: 2 },
      {
        level: 'info',
        message: 'Gemini outbound message sent',
        messageType: 'clientContent',
        textLength: 14,
      },
      {
        level: 'info',
        message: 'Gemini outbound message sent',
        messageType: 'realtimeInput.video',
        mimeType: 'image/jpeg',
        dataBase64Length: 11,
      },
      { level: 'info', message: 'Gemini WebSocket closed', code: 1000, reason: 'done' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret-api-key');
    expect(JSON.stringify(logs)).not.toContain('jpeg-base64');
    expect(JSON.stringify(logs)).not.toContain('What is ahead?');
  });

  it('logs text length for outbound image and text clientContent messages', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = new WebSocketGeminiLiveClient('secret-api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: () => undefined,
        onClose: () => undefined,
      },
    );

    const socket = webSocketMock.sockets[0];
    socket?.open();
    socket?.message({ setupComplete: {} });
    session.sendTextWithVideoFrame('jpeg-base64', 'Describe image');

    const logs = consoleInfo.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logs).toContainEqual({
      level: 'info',
      message: 'Gemini outbound message sent',
      messageType: 'clientContent',
      textLength: 14,
    });
    expect(JSON.stringify(logs)).not.toContain('secret-api-key');
    expect(JSON.stringify(logs)).not.toContain('jpeg-base64');
    expect(JSON.stringify(logs)).not.toContain('Describe image');
  });

  it('does not throw after close and emits a stable socket-not-open error', () => {
    const events: unknown[] = [];
    const session = new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: (event) => events.push(event),
        onClose: () => undefined,
      },
    );

    const socket = webSocketMock.sockets[0];
    socket?.close(1000, 'done');

    expect(() => session.sendText('hello after close')).not.toThrow();
    expect(events).toEqual([
      {
        type: 'error',
        code: 'gemini_socket_not_open',
        message: 'Gemini WebSocket is not open',
      },
    ]);
  });

  it('does not throw after socket error and emits a stable socket-not-open error', () => {
    const events: unknown[] = [];
    const session = new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: (event) => events.push(event),
        onClose: () => undefined,
      },
    );

    const socket = webSocketMock.sockets[0];
    socket?.fail(new Error('upstream reset'));

    expect(() => session.sendText('hello after error')).not.toThrow();
    expect(events).toEqual([
      {
        type: 'error',
        code: 'gemini_socket_error',
        message: 'upstream reset',
      },
      {
        type: 'error',
        code: 'gemini_socket_not_open',
        message: 'Gemini WebSocket is not open',
      },
    ]);
  });

  it('ignores null Gemini messages without emitting parse errors', () => {
    const events: unknown[] = [];
    new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: (event) => events.push(event),
        onClose: () => undefined,
      },
    );

    const socket = webSocketMock.sockets[0];
    socket?.message(null);

    expect(events).toEqual([]);
  });

  it('emits stable parse errors without leaking parser details', () => {
    const events: unknown[] = [];
    new WebSocketGeminiLiveClient('api-key').connect(
      { model: 'models/test-live', instruction: 'Assist briefly.' },
      {
        onEvent: (event) => events.push(event),
        onClose: () => undefined,
      },
    );

    const socket = webSocketMock.sockets[0];
    socket?.rawMessage('{not valid json');

    expect(events).toEqual([
      {
        type: 'error',
        code: 'gemini_parse_error',
        message: 'Failed to parse Gemini message',
      },
    ]);
  });
});

describe('extractProxyEventsFromGemini', () => {
  it('converts Gemini text parts into assistant text proxy events', () => {
    expect(
      extractProxyEventsFromGemini({
        serverContent: {
          modelTurn: {
            parts: [{ text: 'Door ahead.' }, { text: 'Step left.' }],
          },
          turnComplete: true,
        },
      }),
    ).toEqual([
      { type: 'assistant.turn_complete' },
      { type: 'assistant.text', text: 'Door ahead.', final: true },
      { type: 'assistant.text', text: 'Step left.', final: true },
    ]);
  });

  it('converts inline PCM 24 kHz audio into assistant audio proxy events', () => {
    expect(
      extractProxyEventsFromGemini({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/pcm;rate=24000',
                  data: 'audio-base64',
                },
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        type: 'assistant.audio',
        mimeType: 'audio/pcm;rate=24000',
        dataBase64: 'audio-base64',
      },
    ]);
  });

  it('returns no events for setupComplete messages without throwing', () => {
    let events: unknown;

    expect(() => {
      events = extractProxyEventsFromGemini({ setupComplete: {} });
    }).not.toThrow();
    expect(events).toEqual([]);
  });

  it.each([
    ['missing serverContent', {}],
    ['empty serverContent', { serverContent: {} }],
    ['non-object message', null],
  ])('returns no events for %s without throwing', (_name, message) => {
    let events: unknown;

    expect(() => {
      events = extractProxyEventsFromGemini(message);
    }).not.toThrow();
    expect(events).toEqual([]);
  });

  it('ignores inline audio parts without inlineData', () => {
    let events: unknown;

    expect(() => {
      events = extractProxyEventsFromGemini({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { mimeType: 'audio/pcm;rate=24000' } },
              { inlineData: undefined },
            ],
          },
        },
      });
    }).not.toThrow();
    expect(events).toEqual([]);
  });

  it('ignores non-object Gemini parts without throwing', () => {
    let events: unknown;

    expect(() => {
      events = extractProxyEventsFromGemini({
        serverContent: {
          modelTurn: {
            parts: [null],
          },
        },
      });
    }).not.toThrow();
    expect(events).toEqual([]);
  });
});

describe('loadConfig', () => {
  const validEnv = {
    APP_DEV_TOKEN: 'dev-token-123',
    GEMINI_API_KEY: 'gemini-key-123',
  };

  it('uses Flash Live audio defaults with single Gemini key fallback', () => {
    expect(loadConfig(validEnv)).toEqual({
      port: 18787,
      sessionIdleMs: 60_000,
      geminiLiveModel: 'models/gemini-3.1-flash-live-preview',
      geminiResponseModality: 'AUDIO',
      appDevToken: 'dev-token-123',
      geminiApiKeys: ['gemini-key-123'],
    });
  });

  it('normalizes an unprefixed Gemini Live model env value', () => {
    expect(
      loadConfig({
        ...validEnv,
        GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
      }).geminiLiveModel,
    ).toBe('models/gemini-3.1-flash-live-preview');
  });

  it('parses comma-separated Gemini API keys and ignores empty entries', () => {
    expect(
      loadConfig({
        APP_DEV_TOKEN: 'dev-token-123',
        GEMINI_API_KEYS: ' gemini-key-a , gemini-key-b ,, gemini-key-c ',
      }).geminiApiKeys,
    ).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-c']);
  });

  it('prefers GEMINI_API_KEYS over GEMINI_API_KEY when both are present', () => {
    expect(
      loadConfig({
        APP_DEV_TOKEN: 'dev-token-123',
        GEMINI_API_KEY: 'single-key',
        GEMINI_API_KEYS: 'list-key-a,list-key-b',
      }).geminiApiKeys,
    ).toEqual(['list-key-a', 'list-key-b']);
  });

  it('parses Gemini response modality', () => {
    expect(
      loadConfig({
        ...validEnv,
        GEMINI_RESPONSE_MODALITY: 'AUDIO',
      }).geminiResponseModality,
    ).toBe('AUDIO');
  });

  it.each([
    ['bad port', { PORT: 'abc' }],
    ['zero port', { PORT: '0' }],
    ['short token', { APP_DEV_TOKEN: 'short' }],
    ['short single Gemini key', { GEMINI_API_KEY: 'short' }],
    ['short listed Gemini key', { GEMINI_API_KEY: undefined, GEMINI_API_KEYS: 'gemini-key-a,short' }],
    ['empty listed Gemini keys', { GEMINI_API_KEY: undefined, GEMINI_API_KEYS: ',,,' }],
    ['short idle timeout', { SESSION_IDLE_MS: '4999' }],
    ['bad response modality', { GEMINI_RESPONSE_MODALITY: 'VIDEO' }],
  ])('rejects %s', (_name, override) => {
    expect(() => loadConfig({ ...validEnv, ...override })).toThrow(/Invalid proxy config:/);
  });
});

describe('sanitizeLogFields', () => {
  it('redacts sensitive keys and media payloads', () => {
    expect(
      sanitizeLogFields({
        devToken: 'dev-token-123',
        geminiApiKey: 'gemini-key-123',
        dataBase64: 'payload',
        audio: 'payload',
        image: 'payload',
        video: 'payload',
        sessionId: 'session-1',
      }),
    ).toEqual({
      devToken: '[REDACTED]',
      geminiApiKey: '[REDACTED]',
      dataBase64: '[REDACTED]',
      audio: '[REDACTED]',
      image: '[REDACTED]',
      video: '[REDACTED]',
      sessionId: 'session-1',
    });
  });

  it('redacts nested sensitive fields inside objects and arrays while preserving safe metadata', () => {
    expect(
      sanitizeLogFields({
        sessionId: 'session-1',
        request: {
          token: 'token-123',
          count: 2,
          payloads: [
            { data: 'media-base64', mimeType: 'image/jpeg' },
            { inlineData: { data: 'inline-base64', mimeType: 'audio/pcm;rate=16000' } },
          ],
        },
        mediaChunks: [{ data: 'chunk-base64' }],
      }),
    ).toEqual({
      sessionId: 'session-1',
      request: {
        token: '[REDACTED]',
        count: 2,
        payloads: [
          { data: '[REDACTED]', mimeType: 'image/jpeg' },
          { inlineData: '[REDACTED]' },
        ],
      },
      mediaChunks: '[REDACTED]',
    });
  });

  it('redacts sensitive keys case-insensitively including uppercase env-style keys', () => {
    expect(
      sanitizeLogFields({
        GEMINI_API_KEY: 'gemini-key-123',
        GEMINI_API_KEYS: 'gemini-key-a,gemini-key-b',
        geminiApiKeys: ['gemini-key-a', 'gemini-key-b'],
        AUTHORIZATION: 'Bearer token',
        AppDevToken: 'dev-token-123',
        apiKey: 'api-key-123',
        safe: 'keep',
      }),
    ).toEqual({
      GEMINI_API_KEY: '[REDACTED]',
      GEMINI_API_KEYS: '[REDACTED]',
      geminiApiKeys: '[REDACTED]',
      AUTHORIZATION: '[REDACTED]',
      AppDevToken: '[REDACTED]',
      apiKey: '[REDACTED]',
      safe: 'keep',
    });
  });
});
