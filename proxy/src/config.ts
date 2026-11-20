import type { GeminiResponseModality } from './geminiLiveClient.js';

export interface Config {
  port: number;
  sessionIdleMs: number;
  geminiLiveModel: string;
  geminiResponseModality: GeminiResponseModality;
  appDevToken: string;
  geminiApiKeys: string[];
}

const DEFAULT_PORT = 18787;
const DEFAULT_SESSION_IDLE_MS = 60_000;
const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const DEFAULT_GEMINI_RESPONSE_MODALITY: GeminiResponseModality = 'AUDIO';
const MIN_SECRET_LENGTH = 8;

function parsePositiveInteger(name: string, value: string | undefined, defaultValue: number): number {
  const rawValue = value ?? String(defaultValue);
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function requireMinLength(name: string, value: string | undefined, minLength: number): string {
  if (value === undefined || value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }

  return value;
}

function parseGeminiApiKeys(env: NodeJS.ProcessEnv): string[] {
  const usingKeyList = env.GEMINI_API_KEYS !== undefined;
  const sourceName = usingKeyList ? 'GEMINI_API_KEYS' : 'GEMINI_API_KEY';
  const rawValue = usingKeyList ? env.GEMINI_API_KEYS : env.GEMINI_API_KEY;

  if (rawValue === undefined) {
    throw new Error(`${sourceName} must contain at least one key`);
  }

  const keys = rawValue
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (keys.length === 0) {
    throw new Error(`${sourceName} must contain at least one key`);
  }

  for (const key of keys) {
    if (key.length < MIN_SECRET_LENGTH) {
      throw new Error(`${sourceName} entries must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  return keys;
}

function normalizeGeminiLiveModel(value: string | undefined): string {
  const rawValue = value ?? DEFAULT_GEMINI_LIVE_MODEL;
  return rawValue.startsWith('models/') ? rawValue : `models/${rawValue}`;
}

function parseGeminiResponseModality(value: string | undefined): GeminiResponseModality {
  const rawValue = value ?? DEFAULT_GEMINI_RESPONSE_MODALITY;
  if (rawValue !== 'TEXT' && rawValue !== 'AUDIO') {
    throw new Error('GEMINI_RESPONSE_MODALITY must be TEXT or AUDIO');
  }

  return rawValue;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    const port = parsePositiveInteger('PORT', env.PORT, DEFAULT_PORT);
    const sessionIdleMs = parsePositiveInteger('SESSION_IDLE_MS', env.SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS);

    if (sessionIdleMs < 5000) {
      throw new Error('SESSION_IDLE_MS must be at least 5000');
    }

    return {
      port,
      sessionIdleMs,
      geminiLiveModel: normalizeGeminiLiveModel(env.GEMINI_LIVE_MODEL),
      geminiResponseModality: parseGeminiResponseModality(env.GEMINI_RESPONSE_MODALITY),
      appDevToken: requireMinLength('APP_DEV_TOKEN', env.APP_DEV_TOKEN, MIN_SECRET_LENGTH),
      geminiApiKeys: parseGeminiApiKeys(env),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Invalid proxy config: ${message}`);
  }
}
