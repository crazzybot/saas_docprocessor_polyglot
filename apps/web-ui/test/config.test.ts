import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '../src/config';

describe('parseConfig', () => {
  it('reads local mode and strips a trailing slash from the API URL', () => {
    expect(
      parseConfig({ apiBaseUrl: 'https://api.example.com/', auth: { mode: 'local', defaultTenant: 't1' } }),
    ).toEqual({ apiBaseUrl: 'https://api.example.com', auth: { mode: 'local', defaultTenant: 't1' } });
  });

  it('defaults to the page origin and the acme tenant', () => {
    expect(parseConfig({ auth: { mode: 'local' } })).toEqual({
      apiBaseUrl: '',
      auth: { mode: 'local', defaultTenant: 'acme' },
    });
  });

  it('reads entra mode', () => {
    const auth = {
      mode: 'entra',
      clientId: '00000000-0000-0000-0000-000000000001',
      authority: 'https://login.microsoftonline.com/organizations',
      scopes: ['api://x/Documents.Upload'],
    };
    expect(parseConfig({ apiBaseUrl: '', auth }).auth).toEqual(auth);
  });

  it.each([
    [null, 'config.json must be an object'],
    [{ auth: { mode: 'basic' } }, 'auth.mode'],
    [{ apiBaseUrl: 1, auth: { mode: 'local' } }, 'apiBaseUrl'],
    [{ auth: { mode: 'entra', authority: 'a', scopes: ['s'] } }, 'auth.clientId'],
    [{ auth: { mode: 'entra', clientId: 'c', authority: 'a', scopes: [] } }, 'auth.scopes'],
  ])('rejects %j', (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message);
  });
});
