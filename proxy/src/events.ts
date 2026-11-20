import { z } from 'zod';

const StandardBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const Base64Schema = z.string().min(1).refine((value) => {
  if (!StandardBase64Pattern.test(value)) {
    return false;
  }

  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}, 'Must be valid base64');

export const ModeSchema = z.enum(['navigation', 'reading', 'object']);
export type AppMode = z.infer<typeof ModeSchema>;

const AuthStartEventSchema = z.object({
  type: z.literal('auth.start'),
  devToken: z.string().min(1),
  appVersion: z.string().min(1),
}).strict();

const SessionStartEventSchema = z.object({
  type: z.literal('session.start'),
  mode: ModeSchema,
}).strict();

const ModeUpdateEventSchema = z.object({
  type: z.literal('mode.update'),
  mode: ModeSchema,
}).strict();

const AudioChunkEventSchema = z.object({
  type: z.literal('audio.chunk'),
  mimeType: z.literal('audio/pcm;rate=16000'),
  dataBase64: Base64Schema,
  timestampMs: z.number().int().nonnegative(),
}).strict();

const VideoFrameEventSchema = z.object({
  type: z.literal('video.frame'),
  mimeType: z.literal('image/jpeg'),
  dataBase64: Base64Schema,
  timestampMs: z.number().int().nonnegative(),
}).strict();

const TextInputEventSchema = z.object({
  type: z.literal('text.input'),
  text: z.string().min(1),
}).strict();

const SessionEndEventSchema = z.object({ type: z.literal('session.end') }).strict();

const PingEventSchema = z.object({
  type: z.literal('ping'),
  timestampMs: z.number().int().nonnegative().optional(),
}).strict();

export const AndroidEventSchema = z.discriminatedUnion('type', [
  AuthStartEventSchema,
  SessionStartEventSchema,
  ModeUpdateEventSchema,
  AudioChunkEventSchema,
  VideoFrameEventSchema,
  TextInputEventSchema,
  SessionEndEventSchema,
  PingEventSchema,
]);

export type AndroidEvent = z.infer<typeof AndroidEventSchema>;

export interface SanitizedZodIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export class InvalidAndroidEventError extends Error {
  constructor(readonly issues: SanitizedZodIssue[]) {
    super('Invalid Android event: validation failed');
    this.name = 'InvalidAndroidEventError';
  }
}

export type ProxyEvent =
  | { type: 'session.ready'; sessionId: string; mode: AppMode }
  | { type: 'assistant.text'; text: string; final: boolean }
  | { type: 'assistant.audio'; mimeType: 'audio/pcm;rate=24000'; dataBase64: string }
  | { type: 'assistant.turn_complete' }
  | { type: 'mode.confirmed'; mode: AppMode }
  | { type: 'status.update'; state: 'opening' | 'active' | 'cooldown' | 'closed' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; timestampMs: number };

export function parseAndroidEvent(input: unknown): AndroidEvent {
  const parsed = AndroidEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAndroidEventError(parsed.error.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    })));
  }
  return parsed.data;
}
