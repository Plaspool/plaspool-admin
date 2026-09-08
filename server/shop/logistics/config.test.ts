import { afterEach, describe, expect, it } from 'vitest';
import { FEZ_LIVE_URL, FEZ_SANDBOX_URL, TERMINAL_LIVE_URL, TERMINAL_SANDBOX_URL, environmentOf, logisticsEnv, resetLogisticsEnv } from './config';

const KEYS = ['FEZ_USER_ID', 'FEZ_PASSWORD', 'FEZ_SECRET_KEY', 'FEZ_BASE_URL', 'TERMINAL_SECRET_KEY', 'TERMINAL_BASE_URL'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; resetLogisticsEnv(); });

describe('logisticsEnv', () => {
  it('reads nothing as "neither courier configured" and never throws', () => {
    expect(logisticsEnv()).toEqual({ fez: null, terminal: null });
  });
  it('treats an empty string as unset', () => {
    process.env.TERMINAL_SECRET_KEY = '';
    process.env.FEZ_USER_ID = 'u'; process.env.FEZ_PASSWORD = '';
    expect(logisticsEnv()).toEqual({ fez: null, terminal: null });
  });
  it('defaults both base URLs to the sandbox', () => {
    process.env.FEZ_USER_ID = 'G-1'; process.env.FEZ_PASSWORD = 'pw';
    process.env.TERMINAL_SECRET_KEY = 'sk_test_x';
    const env = logisticsEnv();
    expect(env.fez).toEqual({ userId: 'G-1', password: 'pw', secretKey: null, baseUrl: FEZ_SANDBOX_URL });
    expect(env.terminal).toEqual({ secretKey: 'sk_test_x', baseUrl: TERMINAL_SANDBOX_URL });
  });
  it('names the live environment only for the live hosts, trailing slash or not', () => {
    expect(environmentOf(`${FEZ_LIVE_URL}/`, FEZ_LIVE_URL)).toBe('live');
    expect(environmentOf(FEZ_SANDBOX_URL, FEZ_LIVE_URL)).toBe('sandbox');
    expect(environmentOf(TERMINAL_LIVE_URL, TERMINAL_LIVE_URL)).toBe('live');
    expect(environmentOf(TERMINAL_SANDBOX_URL, TERMINAL_LIVE_URL)).toBe('sandbox');
  });
  it('memoises until reset', () => {
    process.env.FEZ_USER_ID = 'a'; process.env.FEZ_PASSWORD = 'b';
    expect(logisticsEnv().fez?.userId).toBe('a');
    process.env.FEZ_USER_ID = 'c';
    expect(logisticsEnv().fez?.userId).toBe('a');
    resetLogisticsEnv();
    expect(logisticsEnv().fez?.userId).toBe('c');
  });
});
