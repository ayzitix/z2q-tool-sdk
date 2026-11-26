import { describe, expect, it } from 'vitest';

import { parseDotenv, readDotenv } from '../src/runtime/dotenv.js';

describe('parseDotenv', () => {
  it('reads assignments, comments, quotes and export lines', () => {
    const { values, skipped } = parseDotenv(
      [
        '# a comment',
        '',
        'EXA_API_KEY=abc123',
        'export SPACED =  value with spaces  ',
        'QUOTED="a b c"',
        "SINGLE='x=y'",
        'TRAILING=token # why this key',
        'EMPTY=',
        'NOT_AN_ASSIGNMENT',
        'ALSO_BAD = ',
      ].join('\n'),
    );
    expect(values).toEqual({
      EXA_API_KEY: 'abc123',
      SPACED: 'value with spaces',
      QUOTED: 'a b c',
      SINGLE: 'x=y',
      TRAILING: 'token',
      EMPTY: '',
      ALSO_BAD: '',
    });
    // The one line without an `=` is reported, never fatal: one stray line must
    // not cost a run its credentials.
    expect(skipped).toEqual([9]);
  });

  it('takes the last duplicate and strips a Windows carriage return', () => {
    const { values } = parseDotenv('A=1\r\nA=2\r\nB=3\r\n');
    expect(values).toEqual({ A: '2', B: '3' });
  });

  it('keeps backslashes and dollar signs literal', () => {
    const text = String.raw`TOKEN=ab\cd$HOME`;
    const { values } = parseDotenv(text);
    expect(values['TOKEN']).toBe(String.raw`ab\cd$HOME`);
  });

  it('is not an assignment for a comment that has an equals sign', () => {
    const { values } = parseDotenv('# KEY=value');
    expect(values).toEqual({});
  });
});

describe('readDotenv', () => {
  it('returns no values for a missing or unreadable file', () => {
    const read = readDotenv(() => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    });
    expect(read('/workspace/.env')).toEqual({ values: {}, skipped: [] });
  });

  it('parses what the reader returns', () => {
    const read = readDotenv(() => 'EXA_API_KEY=k\n');
    expect(read('/workspace/.env').values).toEqual({ EXA_API_KEY: 'k' });
  });
});
