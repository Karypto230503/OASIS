import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProxyEvent } from '../src/events.js';
import type {
  GeminiLiveClient,
  GeminiLiveSession,
  GeminiLiveSessionHandlers,
  GeminiSetupOptions,
} from '../src/geminiLiveClient.js';
import { buildInstruction } from '../src/prompts.js';
import { SessionManager } from '../src/sessionManager.js';

vi.mock('node:crypto', () => ({
  randomUUID: () => 'session-uuid',
}));

class FakeGeminiSession implements GeminiLiveSession {
  readonly texts: string[] = [];
  readonly videoFrames: string[] = [];
  readonly imageTextTurns: { dataBase64: string; text: string }[] = [];
  readonly audioChunks: string[] = [];
  closed = false;

  sendText(text: string): void {
    this.texts.push(text);
  }

  sendTextWithVideoFrame(dataBase64: string, text: string): void {
    this.imageTextTurns.push({ dataBase64, text });
  }

  sendVideoFrame(dataBase64: string): void {
    this.videoFrames.push(dataBase64);
  }

  sendAudioChunk(dataBase64: string): void {
    this.audioChunks.push(dataBase64);
  }

  close(): void {
    this.closed = true;
  }
}

interface ConnectionRecord {
  options: GeminiSetupOptions;
  handlers: GeminiLiveSessionHandlers;
  session: FakeGeminiSession;
}

class FakeGeminiClient implements GeminiLiveClient {
  readonly connections: ConnectionRecord[] = [];

  connect(options: GeminiSetupOptions, handlers: GeminiLiveSessionHandlers): GeminiLiveSession {
    const session = new FakeGeminiSession();
    this.connections.push({ options, handlers, session });
    return session;
  }
}

function createManager(idleMs = 60_000): {
  client: FakeGeminiClient;
  events: ProxyEvent[];
  manager: SessionManager;
} {
  const client = new FakeGeminiClient();
  const events: ProxyEvent[] = [];
  const manager = new SessionManager({
    geminiClient: client,
    model: 'models/test-live',
    responseModality: 'TEXT',
    idleMs,
    emit: (event) => events.push(event),
  });

  return { client, events, manager };
}

function onlyEventTypes(events: ProxyEvent[]): ProxyEvent['type'][] {
  return events.map((event) => event.type);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildInstruction', () => {
  it('uses adaptive language without duplicate translation for every mode', () => {
    for (const mode of ['navigation', 'reading', 'object'] as const) {
      const instruction = buildInstruction(mode);

      expect(instruction).toContain('Default to Bangla when the user language is unclear or the app asks about the current scene.');
      expect(instruction).toContain('If the user asks in English, answer in English.');
      expect(instruction).toContain('Do not repeat the same answer in both Bangla and English unless the user asks for translation.');
    }
  });

  it('uses unified instruction regardless of mode', () => {
    for (const mode of ['navigation', 'reading', 'object'] as const) {
      const instruction = buildInstruction(mode);
      expect(instruction).toContain('Unified mode: You are operating in a continuous silent observation state.');
    }
  });
});

describe('SessionManager', () => {
  it('starts with mode-specific instruction and emits opening, active, and ready events', () => {
    const { client, events, manager } = createManager();

    manager.start('navigation');

    expect(events).toEqual([{ type: 'status.update', state: 'opening' }]);
    client.connections[0]?.handlers.onReady?.();

    expect(client.connections).toHaveLength(1);
    expect(client.connections[0]?.options).toEqual({
      model: 'models/test-live',
      responseModality: 'TEXT',
      instruction: buildInstruction('navigation'),
    });
    expect(events).toEqual([
      { type: 'status.update', state: 'opening' },
      { type: 'status.update', state: 'active' },
      { type: 'session.ready', sessionId: 'session-uuid', mode: 'navigation' },
    ]);
  });

  it('streams video frames and pairs the latest frame with the next text prompt', () => {
    const { client, manager } = createManager();

    manager.start('reading');
    manager.sendVideoFrame('jpeg-base64');
    manager.sendText('What is ahead?');

    const session = client.connections[0]?.session;
    expect(session?.texts).toEqual([]);
    expect(session?.videoFrames).toEqual(['jpeg-base64']);
    expect(session?.imageTextTurns).toEqual([{ dataBase64: 'jpeg-base64', text: 'What is ahead?' }]);
  });

  it('updates mode by closing the old session, opening a new one, and confirming the mode', () => {
    const { client, events, manager } = createManager();

    manager.start('navigation');
    const oldSession = client.connections[0]?.session;
    manager.updateMode('reading');

    expect(oldSession?.closed).toBe(true);
    expect(client.connections).toHaveLength(2);
    expect(client.connections[1]?.options).toEqual({
      model: 'models/test-live',
      responseModality: 'TEXT',
      instruction: buildInstruction('reading'),
    });
    expect(events).toContainEqual({ type: 'mode.confirmed', mode: 'reading' });
  });

  it('opens a session with default object mode when sending before explicit start', () => {
    const { client, manager } = createManager();

    manager.sendText('What is here?');

    expect(client.connections).toHaveLength(1);
    expect(client.connections[0]?.options).toEqual({
      model: 'models/test-live',
      responseModality: 'TEXT',
      instruction: buildInstruction('object'),
    });
    expect(client.connections[0]?.session.texts).toEqual(['What is here?']);
  });

  it('closes the session and emits closed on idle timeout', () => {
    vi.useFakeTimers();
    const { client, events, manager } = createManager(1_000);

    manager.start('object');
    vi.advanceTimersByTime(1_000);

    expect(client.connections[0]?.session.closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'status.update', state: 'closed' });
  });

  it('passes through Gemini events and emits closed when Gemini closes', () => {
    const { client, events, manager } = createManager();

    manager.start('object');
    client.connections[0]?.handlers.onEvent({
      type: 'assistant.text',
      text: 'Door ahead.',
      final: true,
    });
    client.connections[0]?.handlers.onClose(1000, 'done');

    expect(events).toContainEqual({ type: 'assistant.text', text: 'Door ahead.', final: true });
    expect(onlyEventTypes(events).at(-1)).toBe('status.update');
    expect(events.at(-1)).toEqual({ type: 'status.update', state: 'closed' });
  });

  it('emits Gemini close details before closed status', () => {
    const { client, events, manager } = createManager();

    manager.start('object');
    client.connections[0]?.handlers.onClose(1007, 'bad request');

    expect(events.at(-2)).toEqual({
      type: 'error',
      code: 'gemini_session_closed',
      message: 'Gemini session closed: 1007 bad request',
    });
    expect(events.at(-1)).toEqual({ type: 'status.update', state: 'closed' });
  });

  it('emits closed when closing before a session opens', () => {
    const { events, manager } = createManager();

    manager.close();

    expect(events).toEqual([{ type: 'status.update', state: 'closed' }]);
  });
});
