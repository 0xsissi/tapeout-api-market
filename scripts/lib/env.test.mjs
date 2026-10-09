import { describe, expect, it } from 'vitest';

import { readCsvEnv, readOptionalEnv } from './env.mjs';

describe('env helpers', () => {
  it('treats unset and blank env values as undefined', () => {
    expect(readOptionalEnv('A', {})).toBeUndefined();
    expect(readOptionalEnv('A', { A: '' })).toBeUndefined();
    expect(readOptionalEnv('A', { A: '   ' })).toBeUndefined();
  });

  it('splits csv envs into trimmed values', () => {
    expect(readCsvEnv('A', { A: 'gpt-5.4, claude-sonnet-4 , ,gpt-5.4-mini' })).toEqual([
      'gpt-5.4',
      'claude-sonnet-4',
      'gpt-5.4-mini',
    ]);
  });
});
