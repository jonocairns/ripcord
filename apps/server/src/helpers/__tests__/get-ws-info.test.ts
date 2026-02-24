import { describe, expect, test } from 'bun:test';
import type http from 'http';
import { getWsInfo } from '../get-ws-info';

const createRequest = ({
  remoteAddress,
  headers
}: {
  remoteAddress: string;
  headers?: Record<string, string>;
}): http.IncomingMessage => {
  return {
    headers: headers || {},
    socket: {
      remoteAddress
    }
  } as unknown as http.IncomingMessage;
};

describe('getWsInfo trust proxy behavior', () => {
  test('should use direct socket IP when trustProxy is disabled', () => {
    const req = createRequest({
      remoteAddress: '203.0.113.10',
      headers: { 'x-forwarded-for': '198.51.100.99' }
    });

    const info = getWsInfo(undefined, req, {
      trustProxy: false
    });

    expect(info?.ip).toBe('203.0.113.10');
  });

  test('should use forwarded IP when proxy is trusted', () => {
    const req = createRequest({
      remoteAddress: '172.19.0.2',
      headers: { 'x-forwarded-for': '198.51.100.99' }
    });

    const info = getWsInfo(undefined, req, {
      trustProxy: true,
      trustedProxyCidrs: '172.16.0.0/12'
    });

    expect(info?.ip).toBe('198.51.100.99');
  });

  test('should ignore forwarded IP when proxy is untrusted', () => {
    const req = createRequest({
      remoteAddress: '203.0.113.10',
      headers: { 'x-forwarded-for': '198.51.100.99' }
    });

    const info = getWsInfo(undefined, req, {
      trustProxy: true,
      trustedProxyCidrs: '172.16.0.0/12'
    });

    expect(info?.ip).toBe('203.0.113.10');
  });

  test('should pick first IP from forwarded list when trusted', () => {
    const req = createRequest({
      remoteAddress: '10.0.0.5',
      headers: {
        'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3'
      }
    });

    const info = getWsInfo(undefined, req, {
      trustProxy: true,
      trustedProxyCidrs: '10.0.0.0/8'
    });

    expect(info?.ip).toBe('198.51.100.1');
  });
});
