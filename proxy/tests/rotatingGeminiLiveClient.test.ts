import { describe, expect, it } from 'vitest';

import type {
  GeminiLiveClient,
  GeminiLiveSession,
  GeminiLiveSessionHandlers,
  GeminiSetupOptions,
} from '../src/geminiLiveClient.js';
import { RotatingGeminiLiveClient } from '../src/rotatingGeminiLiveClient.js';

class FakeSession implements GeminiLiveSession {
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

class FakeGeminiClient implements GeminiLiveClient {
  readonly connections: Array<{ options: GeminiSetupOptions; handlers: GeminiLiveSessionHandlers; session: FakeSession }> = [];

  connect(options: GeminiSetupOptions, handlers: GeminiLiveSessionHandlers): GeminiLiveSession {
    const session = new FakeSession();
    this.connections.push({ options, handlers, session });
    return session;
  }

  emitError(message: string): void {
    this.connections.at(-1)?.handlers.onEvent({ type: 'error', code: 'gemini_socket_error', message });
  }

  emitClose(code: number, reason: string): void {
    this.connections.at(-1)?.handlers.onClose(code, reason);
  }
}

const setup: GeminiSetupOptions = {
  model: 'models/test-live',
  instruction: 'test instruction',
};

function createClient(now: () => number = () => 1_000): {
  client: RotatingGeminiLiveClient;
  createdKeys: string[];
  delegates: FakeGeminiClient[];
} {
  const createdKeys: string[] = [];
  const delegates: FakeGeminiClient[] = [];
  const client = new RotatingGeminiLiveClient(['gemini-key-a', 'gemini-key-b'], {
    now,
    cooldownMs: 60_000,
    createClient: (apiKey) => {
      createdKeys.push(apiKey);
      const delegate = new FakeGeminiClient();
      delegates.push(delegate);
      return delegate;
    },
  });

  return { client, createdKeys, delegates };
}

describe('RotatingGeminiLiveClient', () => {
  it('selects keys round-robin for new sessions', () => {
    const { client, createdKeys } = createClient();

    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-a']);
  });

  it('retries immediately and skips a cooled key after a quota error event', () => {
    const events: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    client.connect(setup, { onEvent: (event) => events.push(event), onClose: () => undefined });
    delegates[0]?.emitError('RESOURCE_EXHAUSTED: quota exceeded');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b']);
    expect(events).toEqual([]);
  });

  it('retries immediately and skips a cooled key after a rate-limit close reason', () => {
    const closes: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    client.connect(setup, { onEvent: () => undefined, onClose: (code, reason) => closes.push({ code, reason }) });
    delegates[0]?.emitClose(1011, 'rate limit reached');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b']);
    expect(closes).toEqual([]);
  });

  it.each([
    ['permission denied error', 'PERMISSION_DENIED: caller lacks access'],
    ['policy violation error', 'policy_violation: request rejected'],
    ['403 error', '403 forbidden'],
  ])('retries immediately and skips a cooled key after a %s', (_name, message) => {
    const events: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    client.connect(setup, { onEvent: (event) => events.push(event), onClose: () => undefined });
    delegates[0]?.emitError(message);
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b']);
    expect(events).toEqual([]);
  });

  it('retries immediately and skips a cooled key after an access-denied close reason', () => {
    const closes: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    client.connect(setup, { onEvent: () => undefined, onClose: (code, reason) => closes.push({ code, reason }) });
    delegates[0]?.emitClose(1008, 'Your project has been denied access. Please contact support.');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b', 'gemini-key-b']);
    expect(closes).toEqual([]);
  });

  it('retries the active image-text session on the next key after an access-denied close', () => {
    const closes: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    const session = client.connect(setup, { onEvent: () => undefined, onClose: (code, reason) => closes.push({ code, reason }) });
    session.sendTextWithVideoFrame('jpeg-base64', 'describe this scene');
    delegates[0]?.emitClose(1008, 'Your project has been denied access. Please contact support.');

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b']);
    expect(closes).toEqual([]);
    expect(delegates[1]?.connections[0]?.session.imageTextTurns).toEqual([
      { dataBase64: 'jpeg-base64', text: 'describe this scene' },
    ]);
  });

  it('preserves the active replay message across repeated cooldown closes', () => {
    const closes: unknown[] = [];
    const { client, createdKeys, delegates } = createClient();

    const session = client.connect(setup, { onEvent: () => undefined, onClose: (code, reason) => closes.push({ code, reason }) });
    session.sendTextWithVideoFrame('jpeg-base64', 'describe this scene');
    delegates[0]?.emitClose(1008, 'Your project has been denied access. Please contact support.');
    delegates[1]?.emitClose(1008, 'Your project has been denied access. Please contact support.');

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-a']);
    expect(closes).toEqual([]);
    expect(delegates[2]?.connections[0]?.session.imageTextTurns).toEqual([
      { dataBase64: 'jpeg-base64', text: 'describe this scene' },
    ]);
  });

  it('uses the earliest cooling key when all keys are cooling', () => {
    const { client, createdKeys, delegates } = createClient();

    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    delegates[0]?.emitError('quota exceeded');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    delegates[1]?.emitError('429 limit reached');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b', 'gemini-key-a']);
  });

  it('uses a cooled key again after cooldown expires', () => {
    let now = 1_000;
    const { client, createdKeys, delegates } = createClient(() => now);

    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    delegates[0]?.emitError('quota exceeded');
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });
    now = 62_000;
    client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    expect(createdKeys).toEqual(['gemini-key-a', 'gemini-key-b', 'gemini-key-b', 'gemini-key-a']);
  });

  it('clears replay queue after successful delivery to avoid unbounded memory leak', () => {
    const { client, delegates } = createClient();

    const session = client.connect(setup, { onEvent: () => undefined, onClose: () => undefined });

    // Send messages that get delivered to first session
    session.sendText('message 1');
    session.sendAudioChunk('audio-chunk-1');
    session.sendVideoFrame('frame-1');

    expect(delegates[0]?.connections[0]?.session.texts).toEqual(['message 1']);
    expect(delegates[0]?.connections[0]?.session.audioChunks).toEqual(['audio-chunk-1']);
    expect(delegates[0]?.connections[0]?.session.videoFrames).toEqual(['frame-1']);

    // Trigger rotation to second key
    delegates[0]?.emitError('quota exceeded');

    // Send new messages after rotation
    session.sendText('message 2');
    session.sendAudioChunk('audio-chunk-2');

    // Second session should only receive NEW messages, not replays of old ones
    expect(delegates[1]?.connections[0]?.session.texts).toEqual(['message 2']);
    expect(delegates[1]?.connections[0]?.session.audioChunks).toEqual(['audio-chunk-2']);
    expect(delegates[1]?.connections[0]?.session.videoFrames).toEqual([]);

    // Trigger another rotation to verify queue doesn't accumulate across multiple rotations
    delegates[1]?.emitError('rate limit');

    session.sendText('message 3');

    // Third session should only receive message 3, not message 1, 2, or any audio/video
    expect(delegates[2]?.connections[0]?.session.texts).toEqual(['message 3']);
    expect(delegates[2]?.connections[0]?.session.audioChunks).toEqual([]);
    expect(delegates[2]?.connections[0]?.session.videoFrames).toEqual([]);
  });
});
