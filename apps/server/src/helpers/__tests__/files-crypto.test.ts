import { describe, expect, mock, test } from 'bun:test';
import {
  FILE_ACCESS_TOKEN_TTL_MS,
  generateFileToken,
  verifyFileToken
} from '../files-crypto';

const mockGetServerTokenSync = mock(() => 'test-server-token-12345');

mock.module('../../db/queries/server', () => ({
  getServerTokenSync: mockGetServerTokenSync
}));

describe('files-crypto', () => {
  test('generates a signed token with expiry', () => {
    const token = generateFileToken(123, 'channel-token-abc', 1_700_000_000_000);

    expect(typeof token).toBe('string');

    const [expiresAt, signature] = token.split('.', 2);

    expect(Number(expiresAt)).toBe(1_700_000_000_000 + FILE_ACCESS_TOKEN_TTL_MS);
    expect(signature).toHaveLength(64);
  });

  test('generates deterministic tokens for same inputs and time', () => {
    const now = 1_700_000_000_000;

    const tokenA = generateFileToken(123, 'channel-token-abc', now);
    const tokenB = generateFileToken(123, 'channel-token-abc', now);

    expect(tokenA).toBe(tokenB);
  });

  test('generates different tokens with different file ids', () => {
    const now = 1_700_000_000_000;

    const tokenA = generateFileToken(1, 'channel-token-abc', now);
    const tokenB = generateFileToken(2, 'channel-token-abc', now);

    expect(tokenA).not.toBe(tokenB);
  });

  test('generates different tokens with different channel tokens', () => {
    const now = 1_700_000_000_000;

    const tokenA = generateFileToken(123, 'channel-token-a', now);
    const tokenB = generateFileToken(123, 'channel-token-b', now);

    expect(tokenA).not.toBe(tokenB);
  });

  test('verifies a valid token before expiry', () => {
    const now = 1_700_000_000_000;
    const token = generateFileToken(123, 'channel-token-abc', now);

    const isValid = verifyFileToken(123, 'channel-token-abc', token, now + 1_000);

    expect(isValid).toBe(true);
  });

  test('rejects token after expiry', () => {
    const now = 1_700_000_000_000;
    const token = generateFileToken(123, 'channel-token-abc', now);

    const isValid = verifyFileToken(
      123,
      'channel-token-abc',
      token,
      now + FILE_ACCESS_TOKEN_TTL_MS + 1
    );

    expect(isValid).toBe(false);
  });

  test('rejects malformed token', () => {
    const isValid = verifyFileToken(123, 'channel-token-abc', 'invalid-token');

    expect(isValid).toBe(false);
  });

  test('rejects token for different file id', () => {
    const now = 1_700_000_000_000;
    const token = generateFileToken(123, 'channel-token-abc', now);

    const isValid = verifyFileToken(124, 'channel-token-abc', token, now + 1_000);

    expect(isValid).toBe(false);
  });

  test('rejects token for different channel token', () => {
    const now = 1_700_000_000_000;
    const token = generateFileToken(123, 'channel-token-a', now);

    const isValid = verifyFileToken(123, 'channel-token-b', token, now + 1_000);

    expect(isValid).toBe(false);
  });

  test('rejects tampered signature', () => {
    const now = 1_700_000_000_000;
    const token = generateFileToken(123, 'channel-token-abc', now);
    const [expiresAt, signature] = token.split('.', 2);
    const tamperedToken = `${expiresAt}.${(signature ?? '').slice(0, -1)}x`;

    const isValid = verifyFileToken(123, 'channel-token-abc', tamperedToken, now);

    expect(isValid).toBe(false);
  });
});
