import type { TServerInfo } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';

describe('/info', () => {
  test('should return server info', async () => {
    const response = await fetch(`${testsBaseUrl}/info`);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TServerInfo;

    expect(data).toHaveProperty('serverId');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('description');
    expect(data).toHaveProperty('logo');
    expect(data).toHaveProperty('allowNewUsers');

    expect(data.name).toBe('Test Server');
    expect(data.description).toBe('Test server description');
    expect(data.allowNewUsers).toBe(true);
  });

  test('should allow configured CORS origin', async () => {
    const response = await fetch(`${testsBaseUrl}/info`, {
      headers: {
        Origin: 'http://localhost:5173'
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173'
    );
  });

  test('should not set CORS headers for disallowed origin', async () => {
    const response = await fetch(`${testsBaseUrl}/info`, {
      headers: {
        Origin: 'https://evil.example'
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('should reject disallowed preflight CORS request', async () => {
    const response = await fetch(`${testsBaseUrl}/info`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET'
      }
    });

    expect(response.status).toBe(403);

    const data = await response.json();

    expect(data).toHaveProperty('error', 'CORS origin forbidden');
  });
});
