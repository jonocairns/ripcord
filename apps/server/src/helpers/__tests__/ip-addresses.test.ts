import { describe, expect, test } from 'bun:test';
import {
  formatHostForUrl,
  formatResolvedIpAddresses,
  isPrivateOrLocalIp,
  isUnspecifiedBindAddress,
  normalizeIpLiteral,
  resolvePreferredAddress
} from '../ip-addresses';

describe('ip-addresses helpers', () => {
  test('formats IPv6 hosts for URLs', () => {
    expect(formatHostForUrl('2001:db8::10')).toBe('[2001:db8::10]');
    expect(formatHostForUrl('[2001:db8::10]')).toBe('[2001:db8::10]');
    expect(formatHostForUrl('demo.sharkord.com')).toBe('demo.sharkord.com');
  });

  test('normalizes bracketed and mapped IPv4 literals', () => {
    expect(normalizeIpLiteral('[2001:db8::10]')).toBe('2001:db8::10');
    expect(normalizeIpLiteral('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  test('detects private and local IPv4 and IPv6 addresses', () => {
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrLocalIp('172.16.0.10')).toBe(true);
    expect(isPrivateOrLocalIp('192.168.0.10')).toBe(true);
    expect(isPrivateOrLocalIp('::1')).toBe(true);
    expect(isPrivateOrLocalIp('fc00::1')).toBe(true);
    expect(isPrivateOrLocalIp('fe80::1')).toBe(true);
    expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalIp('2606:4700:4700::1111')).toBe(false);
  });

  test('detects unspecified bind addresses', () => {
    expect(isUnspecifiedBindAddress('0.0.0.0')).toBe(true);
    expect(isUnspecifiedBindAddress('::')).toBe(true);
    expect(isUnspecifiedBindAddress('127.0.0.1')).toBe(false);
  });

  test('resolves preferred addresses with fallback', () => {
    expect(
      resolvePreferredAddress(
        { ipv4: '198.51.100.10', ipv6: '2001:db8::10' },
        'ipv6'
      )
    ).toBe('2001:db8::10');
    expect(resolvePreferredAddress({ ipv4: '198.51.100.10' }, 'ipv6')).toBe(
      '198.51.100.10'
    );
  });

  test('formats resolved address maps for debug output', () => {
    expect(
      formatResolvedIpAddresses({
        ipv4: '198.51.100.10',
        ipv6: '2001:db8::10'
      })
    ).toBe('ipv4=198.51.100.10, ipv6=2001:db8::10');
    expect(formatResolvedIpAddresses({})).toBe('unavailable');
  });
});
