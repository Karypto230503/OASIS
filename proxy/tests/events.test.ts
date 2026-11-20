import { describe, expect, it } from 'vitest';

import { parseAndroidEvent } from '../src/events.js';

const expectInvalidAndroidEvent = (input: unknown) => {
  expect(() => parseAndroidEvent(input)).toThrow(/^Invalid Android event:/);
};

describe('parseAndroidEvent', () => {
  it.each([
    [
      'auth.start',
      { type: 'auth.start', devToken: 'dev-token', appVersion: '1.0.0' },
    ],
    ['session.start', { type: 'session.start', mode: 'navigation' }],
    ['mode.update', { type: 'mode.update', mode: 'reading' }],
    [
      'audio.chunk',
      {
        type: 'audio.chunk',
        mimeType: 'audio/pcm;rate=16000',
        dataBase64: 'AAAA',
        timestampMs: 0,
      },
    ],
    [
      'video.frame',
      {
        type: 'video.frame',
        mimeType: 'image/jpeg',
        dataBase64: '/9j/4AAQ',
        timestampMs: 1,
      },
    ],
    ['text.input', { type: 'text.input', text: 'What is ahead?' }],
    ['session.end', { type: 'session.end' }],
    ['ping', { type: 'ping', timestampMs: 123 }],
    ['ping without timestamp', { type: 'ping' }],
  ])('parses valid %s events', (_name, event) => {
    expect(parseAndroidEvent(event)).toEqual(event);
  });

  it('rejects wrong mode', () => {
    expectInvalidAndroidEvent({ type: 'session.start', mode: 'explore' });
    expectInvalidAndroidEvent({ type: 'mode.update', mode: 'explore' });
  });

  it('rejects wrong MIME type', () => {
    expectInvalidAndroidEvent({
      type: 'audio.chunk',
      mimeType: 'audio/webm',
      dataBase64: 'AAAA',
      timestampMs: 0,
    });
    expectInvalidAndroidEvent({
      type: 'video.frame',
      mimeType: 'image/png',
      dataBase64: 'AAAA',
      timestampMs: 0,
    });
  });

  it('rejects negative timestamp', () => {
    expectInvalidAndroidEvent({
      type: 'audio.chunk',
      mimeType: 'audio/pcm;rate=16000',
      dataBase64: 'AAAA',
      timestampMs: -1,
    });
    expectInvalidAndroidEvent({
      type: 'video.frame',
      mimeType: 'image/jpeg',
      dataBase64: 'AAAA',
      timestampMs: -1,
    });
    expectInvalidAndroidEvent({ type: 'ping', timestampMs: -1 });
  });

  it('rejects empty text or data', () => {
    expectInvalidAndroidEvent({ type: 'text.input', text: '' });
    expectInvalidAndroidEvent({
      type: 'audio.chunk',
      mimeType: 'audio/pcm;rate=16000',
      dataBase64: '',
      timestampMs: 0,
    });
    expectInvalidAndroidEvent({
      type: 'video.frame',
      mimeType: 'image/jpeg',
      dataBase64: '',
      timestampMs: 0,
    });
  });

  it('rejects empty auth strings', () => {
    expectInvalidAndroidEvent({ type: 'auth.start', devToken: '', appVersion: '1.0.0' });
    expectInvalidAndroidEvent({ type: 'auth.start', devToken: 'dev-token', appVersion: '' });
  });
});


it('accepts standard padded base64 media payloads', () => {
  expect(parseAndroidEvent({
    type: 'video.frame',
    mimeType: 'image/jpeg',
    dataBase64: 'AQIDBA==',
    timestampMs: 1,
  })).toEqual({
    type: 'video.frame',
    mimeType: 'image/jpeg',
    dataBase64: 'AQIDBA==',
    timestampMs: 1,
  });
});

it.each(['not base64?', '====', 'AAAA===='])('rejects malformed base64 media payload %s', (dataBase64) => {
  expect(() => parseAndroidEvent({
    type: 'video.frame',
    mimeType: 'image/jpeg',
    dataBase64,
    timestampMs: 1,
  })).toThrow(/^Invalid Android event:/);
});

it('rejects unknown event fields', () => {
  expect(() => parseAndroidEvent({
    type: 'ping',
    timestampMs: 1,
    extra: true,
  })).toThrow(/^Invalid Android event:/);
});

it('exposes only sanitized issue details when parsing fails', () => {
  let thrown: unknown;

  try {
    parseAndroidEvent({ type: 'text.input', text: '' });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { issues?: unknown }).issues).toEqual([
    { path: ['text'], code: 'too_small', message: expect.any(String) },
  ]);

  const issues = (thrown as { issues: Record<string, unknown>[] }).issues;
  expect(issues.map((issue) => Object.keys(issue).sort())).toEqual([['code', 'message', 'path']]);
});
