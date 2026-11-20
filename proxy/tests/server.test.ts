import WebSocket from 'ws';
import type { RawData } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import type { ProxyEvent } from '../src/events.js';
import type {
  GeminiLiveClient,
  GeminiLiveSession,
  GeminiLiveSessionHandlers,
  GeminiSetupOptions,
} from '../src/geminiLiveClient.js';
import { logError } from '../src/logger.js';
import { startProxyServer, type ProxyServer } from '../src/server.js';

vi.mock('../src/logger.js', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
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
    queueMicrotask(() => handlers.onReady?.());
    return session;
  }
}

const baseConfig: Config = {
  port: 0,
  sessionIdleMs: 60_000,
  geminiLiveModel: 'models/test-live',
  geminiResponseModality: 'TEXT',
  appDevToken: 'dev-token-123',
  geminiApiKeys: ['gemini-key-123'],
};

const servers: ProxyServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.terminate();
    }
  }

  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('startProxyServer', () => {
  it('authenticates Android clients and emits session lifecycle events on session.start', async () => {
    const { geminiClient, socket } = await startServerAndClient();

    sendJson(socket, { type: 'auth.start', devToken: baseConfig.appDevToken, appVersion: '1.0.0' });
    const messages = await sendAndCollect(socket, 3, () => {
      sendJson(socket, { type: 'session.start', mode: 'navigation' });
    });

    expect(messages).toEqual([
      { type: 'status.update', state: 'opening' },
      { type: 'status.update', state: 'active' },
      { type: 'session.ready', sessionId: expect.any(String), mode: 'navigation' },
    ]);
    expect(geminiClient.connections).toHaveLength(1);
    expect(geminiClient.connections[0]?.options.model).toBe('models/test-live');
    expect(geminiClient.connections[0]?.options.responseModality).toBe('TEXT');
  });

  it('rejects auth.start with the wrong development token and closes the socket', async () => {
    const { geminiClient, socket } = await startServerAndClient();
    const messagesPromise = waitForMessages(socket, 1);
    const closePromise = waitForClose(socket);

    sendJson(socket, { type: 'auth.start', devToken: 'wrong-token', appVersion: '1.0.0' });

    await expect(messagesPromise).resolves.toEqual([
      { type: 'error', code: 'auth_failed', message: 'Invalid development token' },
    ]);
    await expect(closePromise).resolves.toEqual({ code: 1008, reason: 'auth failed' });
    expect(geminiClient.connections).toHaveLength(0);
  });

  it('requires auth.start before any other Android event and closes unauthenticated sockets', async () => {
    const { geminiClient, socket } = await startServerAndClient();
    const messagesPromise = waitForMessages(socket, 1);
    const closePromise = waitForClose(socket);

    sendJson(socket, { type: 'session.start', mode: 'object' });

    await expect(messagesPromise).resolves.toEqual([
      { type: 'error', code: 'auth_required', message: 'First message must be auth.start' },
    ]);
    await expect(closePromise).resolves.toEqual({ code: 1008, reason: 'auth required' });
    expect(geminiClient.connections).toHaveLength(0);
  });

  it('routes text, video, audio, mode updates, and session.end after authentication', async () => {
    const { geminiClient, socket } = await startServerAndClient();
    await authenticateAndStart(socket, 'object');

    sendJson(socket, { type: 'video.frame', mimeType: 'image/jpeg', dataBase64: 'AAAA', timestampMs: 1 });
    sendJson(socket, { type: 'text.input', text: 'What is ahead?' });
    sendJson(socket, {
      type: 'audio.chunk',
      mimeType: 'audio/pcm;rate=16000',
      dataBase64: 'AQIDBA==',
      timestampMs: 2,
    });

    const firstSession = geminiClient.connections[0]?.session;
    await waitForCondition(
      () => firstSession?.imageTextTurns.length === 1 && firstSession.audioChunks.length === 1,
      'routed media and text payloads',
    );

    expect(firstSession?.texts).toEqual([]);
    expect(firstSession?.videoFrames).toEqual(['AAAA']);
    expect(firstSession?.imageTextTurns).toEqual([{ dataBase64: 'AAAA', text: 'What is ahead?' }]);
    expect(firstSession?.audioChunks).toEqual(['AQIDBA==']);

    const modeMessages = await sendAndCollect(socket, 1, () => {
      sendJson(socket, { type: 'mode.update', mode: 'reading' });
    });

    expect(modeMessages).toEqual([{ type: 'mode.confirmed', mode: 'reading' }]);
    expect(firstSession?.closed).toBe(true);
    expect(geminiClient.connections).toHaveLength(2);

    const closePromise = waitForClose(socket);
    const endMessages = await sendAndCollect(socket, 1, () => {
      sendJson(socket, { type: 'session.end' });
    });

    expect(endMessages).toEqual([{ type: 'status.update', state: 'closed' }]);
    await expect(closePromise).resolves.toEqual({ code: 1000, reason: 'session ended' });
    expect(geminiClient.connections[1]?.session.closed).toBe(true);
  });

  it('does not open a new Gemini connection for messages buffered after session.end', async () => {
    const { geminiClient, socket } = await startServerAndClient();
    await authenticateAndStart(socket, 'object');
    expect(geminiClient.connections).toHaveLength(1);

    const messagesPromise = waitForMessages(socket, 1);
    const closePromise = waitForClose(socket);

    sendJson(socket, { type: 'session.end' });
    sendJson(socket, { type: 'text.input', text: 'ignore after end' });

    await expect(messagesPromise).resolves.toEqual([{ type: 'status.update', state: 'closed' }]);
    await expect(closePromise).resolves.toEqual({ code: 1000, reason: 'session ended' });
    expect(geminiClient.connections).toHaveLength(1);
    expect(geminiClient.connections[0]?.session.closed).toBe(true);
  });

  it('emits errors for malformed JSON and invalid events after auth without crashing', async () => {
    const { socket } = await startServerAndClient();

    sendJson(socket, { type: 'auth.start', devToken: baseConfig.appDevToken, appVersion: '1.0.0' });
    const malformedMessages = await sendAndCollectRaw(socket, 1, () => {
      socket.send('{');
    });

    expect(malformedMessages).toEqual([
      { type: 'error', code: 'invalid_json', message: 'Message must be valid JSON' },
    ]);

    const invalidMessages = await sendAndCollect(socket, 1, () => {
      sendJson(socket, { type: 'text.input', text: '' });
    });

    expect(invalidMessages).toEqual([
      { type: 'error', code: 'invalid_event', message: 'Invalid Android event' },
    ]);

    const pongMessages = await sendAndCollect(socket, 1, () => {
      sendJson(socket, { type: 'ping', timestampMs: 1234 });
    });

    expect(pongMessages).toEqual([{ type: 'pong', timestampMs: 1234 }]);
  });

  it('logs sanitized invalid event diagnostics without raw payload fields', async () => {
    const { socket } = await startServerAndClient();
    const rawPayload = 'SECRET_BASE64_PAYLOAD';

    sendJson(socket, { type: 'auth.start', devToken: baseConfig.appDevToken, appVersion: '1.0.0' });
    await sendAndCollect(socket, 1, () => {
      sendJson(socket, {
        type: 'video.frame',
        mimeType: 'image/jpeg',
        dataBase64: rawPayload,
        timestampMs: -1,
      });
    });

    expect(logError).toHaveBeenCalledWith('Rejected invalid Android event', expect.objectContaining({
      eventType: 'video.frame',
      dataBase64Length: rawPayload.length,
      issues: expect.arrayContaining([
        { path: ['timestampMs'], code: 'too_small', message: expect.any(String) },
      ]),
    }));
    const invalidEventLog = vi.mocked(logError).mock.calls.find(([message]) => message === 'Rejected invalid Android event')?.[1];
    expect(JSON.stringify(invalidEventLog)).not.toContain(rawPayload);
    expect(invalidEventLog).not.toHaveProperty('payload');
    expect(invalidEventLog).not.toHaveProperty('dataBase64');
  });

  it('responds to ping with pong after authentication', async () => {
    const { socket } = await startServerAndClient();

    sendJson(socket, { type: 'auth.start', devToken: baseConfig.appDevToken, appVersion: '1.0.0' });
    const messages = await sendAndCollect(socket, 1, () => {
      sendJson(socket, { type: 'ping', timestampMs: 9876 });
    });

    expect(messages).toEqual([{ type: 'pong', timestampMs: 9876 }]);
  });

  it('creates one Gemini client for all authenticated sockets on the server', async () => {
    const geminiClient = new FakeGeminiClient();
    const createGeminiClient = vi.fn(() => geminiClient);
    const server = startProxyServer(baseConfig, { createGeminiClient });
    servers.push(server);
    await server.ready;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    sockets.push(firstSocket);
    await waitForOpen(firstSocket);
    await authenticateAndStart(firstSocket, 'navigation');

    const secondSocket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    sockets.push(secondSocket);
    await waitForOpen(secondSocket);
    await authenticateAndStart(secondSocket, 'reading');

    expect(createGeminiClient).toHaveBeenCalledTimes(1);
    expect(geminiClient.connections).toHaveLength(2);
  });
});

async function startServerAndClient(): Promise<{ geminiClient: FakeGeminiClient; server: ProxyServer; socket: WebSocket }> {
  const geminiClient = new FakeGeminiClient();
  const server = startProxyServer(baseConfig, { createGeminiClient: () => geminiClient });
  servers.push(server);
  await server.ready;

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  sockets.push(socket);
  await waitForOpen(socket);

  return { geminiClient, server, socket };
}

async function authenticateAndStart(socket: WebSocket, mode: 'navigation' | 'reading' | 'object'): Promise<ProxyEvent[]> {
  sendJson(socket, { type: 'auth.start', devToken: baseConfig.appDevToken, appVersion: '1.0.0' });
  return sendAndCollect(socket, 3, () => {
    sendJson(socket, { type: 'session.start', mode });
  });
}

function sendJson(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

function sendAndCollect(socket: WebSocket, count: number, send: () => void): Promise<ProxyEvent[]> {
  return sendAndCollectRaw(socket, count, send);
}

function sendAndCollectRaw(socket: WebSocket, count: number, send: () => void): Promise<ProxyEvent[]> {
  const messagesPromise = waitForMessages(socket, count);
  send();
  return messagesPromise;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };

      socket.once('open', onOpen);
      socket.once('error', onError);
    }),
    'WebSocket open',
  );
}

function waitForMessages(socket: WebSocket, count: number): Promise<ProxyEvent[]> {
  return withTimeout(
    new Promise<ProxyEvent[]>((resolve, reject) => {
      const messages: ProxyEvent[] = [];
      const onMessage = (data: RawData) => {
        try {
          messages.push(JSON.parse(data.toString()) as ProxyEvent);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }

        if (messages.length === count) {
          cleanup();
          resolve(messages);
        }
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`WebSocket closed before receiving ${count} messages: ${code}`));
      };
      const cleanup = () => {
        socket.off('message', onMessage);
        socket.off('close', onClose);
      };

      socket.on('message', onMessage);
      socket.once('close', onClose);
    }),
    `${count} WebSocket message(s)`,
  );
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return withTimeout(
    new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    }),
    'WebSocket close',
  );
}

function waitForCondition(check: () => boolean, description: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const poll = () => {
        if (check()) {
          resolve();
          return;
        }

        setTimeout(poll, 0);
      };

      poll();
    }),
    description,
  );
}

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description}`));
    }, 1_000);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}
