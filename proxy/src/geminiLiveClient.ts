import WebSocket from 'ws';

import type { ProxyEvent } from './events.js';
import { logInfo } from './logger.js';

const GEMINI_LIVE_WSS_BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export type GeminiResponseModality = 'TEXT' | 'AUDIO';

export interface GeminiSetupOptions {
  model: string;
  instruction: string;
  responseModality?: GeminiResponseModality;
}

export interface GeminiSetupMessage {
  setup: {
    model: string;
    systemInstruction: {
      parts: [{ text: string }];
    };
    generationConfig: {
      responseModalities: [GeminiResponseModality];
      speechConfig?: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: string };
        };
      };
    };
  };
}

export interface GeminiTextMessage {
  clientContent: {
    turns: [
      {
        role: 'user';
        parts: [{ text: string }];
      },
    ];
    turnComplete: true;
  };
}

export interface GeminiImageTextMessage {
  clientContent: {
    turns: [
      {
        role: 'user';
        parts: [
          { inlineData: { mimeType: 'image/jpeg'; data: string } },
          { text: string },
        ];
      },
    ];
    turnComplete: true;
  };
}

export type GeminiRealtimeInputMessage =
  | {
      realtimeInput: {
        video: {
          mimeType: 'image/jpeg';
          data: string;
        };
      };
    }
  | {
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000';
          data: string;
        };
      };
    };

export type GeminiLiveMessage = GeminiSetupMessage | GeminiTextMessage | GeminiImageTextMessage | GeminiRealtimeInputMessage;

interface GeminiInlineDataPart {
  inlineData?: {
    mimeType?: unknown;
    data?: unknown;
  };
}

interface GeminiTextPart {
  text?: unknown;
}

interface GeminiServerMessage {
  serverContent?: {
    modelTurn?: {
      parts?: unknown;
    };
    turnComplete?: unknown;
  };
}

interface GeminiSetupCompleteMessage {
  setupComplete?: unknown;
}

export interface GeminiLiveSession {
  sendText(text: string): void;
  sendTextWithVideoFrame(dataBase64: string, text: string): void;
  sendVideoFrame(dataBase64: string): void;
  sendAudioChunk(dataBase64: string): void;
  close(): void;
}

export interface GeminiLiveSessionHandlers {
  onEvent(event: ProxyEvent): void;
  onClose(code: number, reason: string): void;
  onReady?(): void;
}

export interface GeminiLiveClient {
  connect(options: GeminiSetupOptions, handlers: GeminiLiveSessionHandlers): GeminiLiveSession;
}

export function buildGeminiSetupMessage({
  model,
  instruction,
  responseModality = 'TEXT',
}: GeminiSetupOptions): GeminiSetupMessage {
  return {
    setup: {
      model,
      systemInstruction: {
        parts: [{ text: instruction }],
      },
      generationConfig: {
        responseModalities: [responseModality],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    },
  };
}

export function buildGeminiTextMessage(text: string): GeminiTextMessage {
  return {
    clientContent: {
      turns: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    },
  };
}

export function buildGeminiImageTextMessage(dataBase64: string, text: string): GeminiImageTextMessage {
  return {
    clientContent: {
      turns: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: dataBase64 } },
            { text },
          ],
        },
      ],
      turnComplete: true,
    },
  };
}

export function buildGeminiVideoMessage(dataBase64: string): GeminiRealtimeInputMessage {
  return {
    realtimeInput: {
      video: {
        mimeType: 'image/jpeg',
        data: dataBase64,
      },
    },
  };
}

export function buildGeminiAudioMessage(dataBase64: string): GeminiRealtimeInputMessage {
  return {
    realtimeInput: {
      audio: {
        mimeType: 'audio/pcm;rate=16000',
        data: dataBase64,
      },
    },
  };
}

export function extractProxyEventsFromGemini(message: unknown): ProxyEvent[] {
  if (!isRecord(message)) {
    return [];
  }

  const serverMessage = message as GeminiServerMessage;
  const events: ProxyEvent[] = [];

  // Emit turn_complete whenever turnComplete flag is set
  if (serverMessage.serverContent?.turnComplete === true) {
    events.push({ type: 'assistant.turn_complete' });
  }

  const parts = serverMessage.serverContent?.modelTurn?.parts;
  if (!Array.isArray(parts)) {
    return events;
  }

  const final = serverMessage.serverContent?.turnComplete === true;

  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }

    const geminiPart = part as GeminiTextPart & GeminiInlineDataPart;

    if (typeof geminiPart.text === 'string' && geminiPart.text.length > 0) {
      events.push({ type: 'assistant.text', text: geminiPart.text, final });
    }

    if (
      geminiPart.inlineData?.mimeType === 'audio/pcm;rate=24000' &&
      typeof geminiPart.inlineData.data === 'string' &&
      geminiPart.inlineData.data.length > 0
    ) {
      events.push({
        type: 'assistant.audio',
        mimeType: 'audio/pcm;rate=24000',
        dataBase64: geminiPart.inlineData.data,
      });
    }
  }

  return events;
}

export class WebSocketGeminiLiveClient implements GeminiLiveClient {
  constructor(private readonly geminiApiKey: string) {}

  connect(options: GeminiSetupOptions, handlers: GeminiLiveSessionHandlers): GeminiLiveSession {
    const socket = new WebSocket(buildGeminiLiveUrl(this.geminiApiKey));

    const session = new WebSocketGeminiLiveSession(socket, buildGeminiSetupMessage(options), handlers);

    socket.on('open', () => {
      logInfo('Gemini WebSocket opened');
      session.handleOpen();
    });

    socket.on('message', (data) => {
      try {
        const raw = data.toString();
        const message = JSON.parse(raw) as unknown;
        session.handleMessage(message);
        for (const event of extractProxyEventsFromGemini(message)) {
          handlers.onEvent(event);
        }
      } catch {
        handlers.onEvent({
          type: 'error',
          code: 'gemini_parse_error',
          message: 'Failed to parse Gemini message',
        });
      }
    });

    socket.on('close', (code, reason) => {
      logInfo('Gemini WebSocket closed', { code, reason: reason.toString() });
      session.handleClose();
      handlers.onClose(code, reason.toString());
    });

    socket.on('error', (error) => {
      logInfo('Gemini WebSocket error', { error: error.message });
      session.handleError();
      handlers.onEvent({
        type: 'error',
        code: 'gemini_socket_error',
        message: error.message,
      });
    });

    return session;
  }
}

class WebSocketGeminiLiveSession implements GeminiLiveSession {
  private readonly queuedMessages: GeminiLiveMessage[] = [];
  private setupComplete = false;
  private socketFailed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly setupMessage: GeminiSetupMessage,
    private readonly handlers: GeminiLiveSessionHandlers,
  ) {}

  handleClose(): void {
    this.queuedMessages.length = 0;
  }

  handleError(): void {
    this.socketFailed = true;
    this.queuedMessages.length = 0;
  }

  handleOpen(): void {
    this.sendOpenMessage(this.setupMessage);
  }

  handleMessage(message: unknown): void {
    if (isGeminiSetupCompleteMessage(message) && !this.setupComplete) {
      logInfo('Gemini setup complete', { queuedMessageCount: this.queuedMessages.length });
      this.setupComplete = true;
      this.handlers.onReady?.();
      this.flushQueuedMessages();
    }
  }

  sendText(text: string): void {
    this.send(buildGeminiTextMessage(text));
  }

  sendTextWithVideoFrame(dataBase64: string, text: string): void {
    this.send(buildGeminiImageTextMessage(dataBase64, text));
  }

  sendVideoFrame(dataBase64: string): void {
    this.send(buildGeminiVideoMessage(dataBase64));
  }

  sendAudioChunk(dataBase64: string): void {
    this.send(buildGeminiAudioMessage(dataBase64));
  }

  close(): void {
    this.socket.close(1000);
  }

  private send(message: GeminiLiveMessage): void {
    if (this.socket.readyState === WebSocket.CONNECTING && !this.socketFailed) {
      this.queuedMessages.push(message);
      return;
    }

    if (this.socket.readyState !== WebSocket.OPEN) {
      this.emitNotOpenError();
      return;
    }

    if (!this.setupComplete) {
      this.queuedMessages.push(message);
      return;
    }

    this.sendOpenMessage(message);
  }

  private flushQueuedMessages(): void {
    while (this.queuedMessages.length > 0 && this.socket.readyState === WebSocket.OPEN) {
      const message = this.queuedMessages.shift();
      if (message) {
        this.sendOpenMessage(message);
      }
    }
  }

  private sendOpenMessage(message: GeminiLiveMessage): void {
    try {
      this.socket.send(JSON.stringify(message));
      logInfo('Gemini outbound message sent', describeGeminiOutboundMessage(message));
    } catch {
      this.emitNotOpenError();
    }
  }

  private emitNotOpenError(): void {
    this.handlers.onEvent({
      type: 'error',
      code: 'gemini_socket_not_open',
      message: 'Gemini WebSocket is not open',
    });
  }
}

function describeGeminiOutboundMessage(message: GeminiLiveMessage): Record<string, unknown> {
  if ('setup' in message) {
    return {
      messageType: 'setup',
      model: message.setup.model,
      responseModalities: message.setup.generationConfig.responseModalities,
    };
  }

  if ('clientContent' in message) {
    const textPart = message.clientContent.turns[0]?.parts.find((part) => 'text' in part);
    const text = textPart && 'text' in textPart ? textPart.text : undefined;
    return {
      messageType: 'clientContent',
      textLength: typeof text === 'string' ? text.length : undefined,
    };
  }

  if ('video' in message.realtimeInput) {
    return {
      messageType: 'realtimeInput.video',
      mimeType: message.realtimeInput.video.mimeType,
      dataBase64Length: message.realtimeInput.video.data.length,
    };
  }

  return {
    messageType: 'realtimeInput.audio',
    mimeType: message.realtimeInput.audio.mimeType,
    dataBase64Length: message.realtimeInput.audio.data.length,
  };
}

function isGeminiSetupCompleteMessage(message: unknown): boolean {
  return isRecord(message) && (message as GeminiSetupCompleteMessage).setupComplete !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildGeminiLiveUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WSS_BASE_URL}?key=${encodeURIComponent(apiKey)}`;
}
