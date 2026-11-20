import { describe, expect, it } from 'vitest';

import { buildInstruction } from '../src/prompts.js';

const BASE_INSTRUCTIONS = [
  'You are a concise visual assistant for a blind user.',
  'Describe only useful information.',
  'Prioritize safety, orientation, readable text, and actionable observations.',
  'Be brief unless the user asks for detail.',
  'Mention uncertainty.',
  'Do not invent details you cannot see or hear.',
];

describe('buildInstruction', () => {
  it.each(['navigation', 'reading', 'object'] as const)(
    'includes base instructions for %s mode',
    (mode) => {
      const instruction = buildInstruction(mode);

      for (const baseInstruction of BASE_INSTRUCTIONS) {
        expect(instruction).toContain(baseInstruction);
      }
    },
  );

  it('includes unified instruction', () => {
    const instruction = buildInstruction('navigation');

    expect(instruction).toContain('Unified mode: You are operating in a continuous silent observation state.');
    expect(instruction).toContain('DO NOT speak or describe the scene until the user explicitly speaks an instruction.');
    expect(instruction).toContain('If interrupted, immediately stop your current response and wait for the next instruction.');
  });
});
