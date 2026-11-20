import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { loadConfig, type Config } from './config.js';
import {
  InvalidAndroidEventError,
  parseAndroidEvent,
  type AndroidEvent,
  type ProxyEvent,
  type SanitizedZodIssue,
} from './events.js';
import { type GeminiLiveClient } from './geminiLiveClient.js';
import { logError, logInfo } from './logger.js';
import { RotatingGeminiLiveClient } from './rotatingGeminiLiveClient.js';
import { SessionManager } from './sessionManager.js';

export interface ProxyServerOptions {
  createGeminiClient?(config: Config): GeminiLiveClient;
  now?(): number;
}

export interface ProxyServer {
  readonly ready: Promise<void>;
  readonly port: number;
  close(): Promise<void>;
}

const AUTH_FAILED_CLOSE_CODE = 1008;

export function startProxyServer(config: Config, options: ProxyServerOptions = {}): ProxyServer {
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });
  const now = options.now ?? Date.now;
  const geminiClient = createGeminiClient(config, options);
  let closingPromise: Promise<void> | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    const onListening = () => {
      httpServer.off('error', onListenError);
      logInfo('Proxy server listening', { port: getListeningPort(httpServer) });
      resolve();
    };

    const onListenError = (error: Error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };

    httpServer.once('listening', onListening);
    httpServer.once('error', onListenError);
  });

  httpServer.on('error', (error) => {
    logError('Proxy server error', { error: error.message });
  });

  webSocketServer.on('connection', (socket, request) => {
    handleConnection(socket, request, config, geminiClient, now);
  });

  webSocketServer.on('error', (error) => {
    logError('Proxy WebSocket server error', { error: error.message });
  });

  httpServer.listen(config.port, '0.0.0.0');

  return {
    ready,
    get port() {
      return getListeningPort(httpServer);
    },
    close() {
      closingPromise ??= closeProxyServer(webSocketServer, httpServer);
      return closingPromise;
    },
  };
}

function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  config: Config,
  geminiClient: GeminiLiveClient,
  now: () => number,
): void {
  const connectionId = randomUUID();
  let authenticated = false;
  let manager: SessionManager | undefined;

  logInfo('Android WebSocket connected', {
    connectionId,
    remoteAddress: request.socket.remoteAddress,
  });

  socket.on('message', (data) => {
    const parsedMessage = parseJsonMessage(data);
    if (!parsedMessage.ok) {
      emitError(socket, 'invalid_json', 'Message must be valid JSON');
      logError('Rejected malformed Android message', { connectionId });
      if (!authenticated) {
        closeSocket(socket, AUTH_FAILED_CLOSE_CODE, 'invalid json');
      }
      return;
    }

    const event = parseEvent(parsedMessage.value);
    if (!event.ok) {
      emitError(socket, 'invalid_event', 'Invalid Android event');
      logError('Rejected invalid Android event', {
        connectionId,
        ...invalidAndroidEventLogDetails(parsedMessage.value, event.issues),
      });
      if (!authenticated) {
        closeSocket(socket, AUTH_FAILED_CLOSE_CODE, 'auth required');
      }
      return;
    }

    if (!authenticated) {
      if (event.value.type !== 'auth.start') {
        emitThenClose(
          socket,
          { type: 'error', code: 'auth_required', message: 'First message must be auth.start' },
          AUTH_FAILED_CLOSE_CODE,
          'auth required',
        );
        logError('Rejected unauthenticated Android message', { connectionId, eventType: event.value.type });
        return;
      }

      if (event.value.devToken !== config.appDevToken) {
        emitThenClose(
          socket,
          { type: 'error', code: 'auth_failed', message: 'Invalid development token' },
          AUTH_FAILED_CLOSE_CODE,
          'auth failed',
        );
        logError('Rejected Android auth', { connectionId, appVersion: event.value.appVersion });
        return;
      }

      authenticated = true;
      manager = new SessionManager({
        geminiClient,
        model: config.geminiLiveModel,
        responseModality: config.geminiResponseModality,
        idleMs: config.sessionIdleMs,
        emit: (proxyEvent) => emitProxyEvent(socket, proxyEvent, connectionId),
      });
      logInfo('Android WebSocket authenticated', { connectionId, appVersion: event.value.appVersion });
      return;
    }

    logInfo('Android event received', {
      connectionId,
      eventType: event.value.type,
      ...androidEventLogDetails(event.value),
    });
    routeAuthenticatedEvent(event.value, manager, () => {
      manager = undefined;
    }, socket, now, connectionId);
  });

  socket.on('close', (code, reason) => {
    const existingManager = manager;
    manager = undefined;
    existingManager?.close();
    logInfo('Android WebSocket closed', { connectionId, code, reason: reason.toString() });
  });

  socket.on('error', (error) => {
    logError('Android WebSocket error', { connectionId, error: error.message });
  });
}

function routeAuthenticatedEvent(
  event: AndroidEvent,
  manager: SessionManager | undefined,
  clearManager: () => void,
  socket: WebSocket,
  now: () => number,
  connectionId: string,
): void {
  if (event.type === 'ping') {
    emitProxyEvent(socket, { type: 'pong', timestampMs: event.timestampMs ?? now() }, connectionId);
    return;
  }

  if (event.type === 'auth.start') {
    emitError(socket, 'invalid_event', 'auth.start is only allowed as the first message');
    logError('Rejected duplicate Android auth', { connectionId });
    return;
  }

  if (!manager) {
    emitError(socket, 'session_unavailable', 'Session is not available');
    logError('Rejected Android event without session manager', { connectionId, eventType: event.type });
    return;
  }

  try {
    switch (event.type) {
      case 'session.start':
        manager.start(event.mode);
        break;
      case 'mode.update':
        manager.updateMode(event.mode);
        break;
      case 'text.input':
        manager.sendText(event.text);
        break;
      case 'video.frame':
        manager.sendVideoFrame(event.dataBase64);
        break;
      case 'audio.chunk':
        manager.sendAudioChunk(event.dataBase64);
        break;
      case 'session.end':
        clearManager();
        manager.close();
        closeSocket(socket, 1000, 'session ended');
        break;
    }
  } catch (error) {
    emitError(socket, 'session_error', 'Failed to handle Android event');
    logError('Failed to handle Android event', {
      connectionId,
      eventType: event.type,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

function createGeminiClient(config: Config, options: ProxyServerOptions): GeminiLiveClient {
  return options.createGeminiClient?.(config) ?? new RotatingGeminiLiveClient(config.geminiApiKeys);
}

function parseJsonMessage(data: RawData): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawDataToString(data)) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseEvent(value: unknown): { ok: true; value: AndroidEvent } | { ok: false; issues: SanitizedZodIssue[] } {
  try {
    return { ok: true, value: parseAndroidEvent(value) };
  } catch (error) {
    return { ok: false, issues: error instanceof InvalidAndroidEventError ? error.issues : [] };
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

function invalidAndroidEventLogDetails(value: unknown, issues: SanitizedZodIssue[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return { issues };
  }

  return {
    eventType: typeof value.type === 'string' ? value.type : undefined,
    dataBase64Length: typeof value.dataBase64 === 'string' ? value.dataBase64.length : undefined,
    issues,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function androidEventLogDetails(event: AndroidEvent): Record<string, unknown> {
  switch (event.type) {
    case 'session.start':
    case 'mode.update':
      return { mode: event.mode };
    case 'text.input':
      return { textLength: event.text.length };
    case 'video.frame':
    case 'audio.chunk':
      return {
        mimeType: event.mimeType,
        dataBase64Length: event.dataBase64.length,
        timestampMs: event.timestampMs,
      };
    case 'ping':
      return { timestampMs: event.timestampMs };
    case 'session.end':
    case 'auth.start':
      return {};
  }
}

function proxyEventLogDetails(event: ProxyEvent): Record<string, unknown> {
  switch (event.type) {
    case 'status.update':
      return { state: event.state };
    case 'session.ready':
      return { mode: event.mode };
    case 'assistant.text':
      return { textLength: event.text.length, final: event.final };
    case 'assistant.audio':
      return { mimeType: event.mimeType, dataBase64Length: event.dataBase64.length };
    case 'assistant.turn_complete':
      return {};
    case 'mode.confirmed':
      return { mode: event.mode };
    case 'error':
      return { code: event.code, message: event.message };
    case 'pong':
      return { timestampMs: event.timestampMs };
  }
}

function emitError(socket: WebSocket, code: string, message: string): void {
  emitProxyEvent(socket, { type: 'error', code, message });
}

function emitThenClose(socket: WebSocket, event: ProxyEvent, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) {
    closeSocket(socket, code, reason);
    return;
  }

  socket.send(JSON.stringify(event), (error) => {
    if (error) {
      logError('Failed to send ProxyEvent before close', { error: error.message, eventType: event.type });
    }
    closeSocket(socket, code, reason);
  });
}

function emitProxyEvent(socket: WebSocket, event: ProxyEvent, connectionId?: string): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (connectionId) {
    logInfo('Proxy event emitted', {
      connectionId,
      eventType: event.type,
      ...proxyEventLogDetails(event),
    });
  }

  socket.send(JSON.stringify(event), (error) => {
    if (error) {
      logError('Failed to send ProxyEvent', { error: error.message, eventType: event.type });
    }
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

function getListeningPort(server: HttpServer): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    return (address as AddressInfo).port;
  }

  return 0;
}

async function closeProxyServer(webSocketServer: WebSocketServer, httpServer: HttpServer): Promise<void> {
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.terminate();
    }
  }

  await new Promise<void>((resolve) => {
    webSocketServer.close(() => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url;
}

async function runFromEnvironment(): Promise<void> {
  try {
    await import('dotenv/config');
    const config = loadConfig();
    const server = startProxyServer(config);
    await server.ready;

    const shutdown = (signal: NodeJS.Signals) => {
      logInfo('Stopping proxy server', { signal });
      void server.close().then(
        () => {
          process.exit(0);
        },
        (error: unknown) => {
          logError('Failed to stop proxy server', {
            error: error instanceof Error ? error.message : 'unknown error',
          });
          process.exit(1);
        },
      );
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    logError('Failed to start proxy server', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    process.exit(1);
  }
}

if (isEntrypoint()) {
  void runFromEnvironment();
}
