export type LogFields = Record<string, unknown>;

const REDACTED = '[REDACTED]';
const REDACTED_KEYS = new Set([
  'devtoken',
  'token',
  'appdevtoken',
  'geminiapikey',
  'geminiapikeys',
  'geminiapikeylist',
  'apikey',
  'authorization',
  'database64',
  'data',
  'audio',
  'image',
  'video',
  'inlinedata',
  'mediachunks',
]);
export function sanitizeLogFields(fields: LogFields = {}): LogFields {
  return sanitizeValue(fields) as LogFields;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (!isPlainLogObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      isRedactedKey(key) ? REDACTED : sanitizeValue(entryValue),
    ]),
  );
}

function isPlainLogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.has(normalizeKey(key));
}

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

export function logInfo(message: string, fields: LogFields = {}): void {
  console.info(JSON.stringify({ level: 'info', message, ...sanitizeLogFields(fields) }));
}

export function logError(message: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ level: 'error', message, ...sanitizeLogFields(fields) }));
}
