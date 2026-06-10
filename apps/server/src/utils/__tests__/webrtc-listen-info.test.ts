import { describe, expect, test } from 'bun:test';
import { buildWebRtcListenInfos } from '../webrtc-listen-info';

describe('buildWebRtcListenInfos', () => {
	test('builds dual-stack listeners in preferred-family order', () => {
		const listenInfos = buildWebRtcListenInfos(
			{
				port: 40000,
				preferredFamily: 'ipv6',
				ipv4: {
					enabled: true,
					bindAddress: '0.0.0.0',
					announcedAddress: '198.51.100.10',
				},
				ipv6: {
					enabled: true,
					bindAddress: '::',
					announcedAddress: '2001:db8::10',
				},
			},
			{
				isProduction: true,
				publicIps: {},
			},
		);

		expect(listenInfos).toHaveLength(4);
		expect(listenInfos[0]?.family).toBe('ipv6');
		expect(listenInfos[0]?.protocol).toBe('udp');
		expect(listenInfos[0]?.flags?.ipv6Only).toBe(true);
		expect(listenInfos[1]?.family).toBe('ipv6');
		expect(listenInfos[2]?.family).toBe('ipv4');
		expect(listenInfos[2]?.protocol).toBe('udp');
	});

	test('skips unspecified production listeners without an announced address', () => {
		const listenInfos = buildWebRtcListenInfos(
			{
				port: 40000,
				preferredFamily: 'ipv4',
				ipv4: {
					enabled: true,
					bindAddress: '0.0.0.0',
					announcedAddress: '',
				},
				ipv6: {
					enabled: true,
					bindAddress: '::',
					announcedAddress: '',
				},
			},
			{
				isProduction: true,
				publicIps: {},
			},
		);

		expect(listenInfos).toHaveLength(0);
	});

	test('allows local development loopback listeners without announced addresses', () => {
		const listenInfos = buildWebRtcListenInfos(
			{
				port: 40000,
				preferredFamily: 'ipv4',
				ipv4: {
					enabled: true,
					bindAddress: '',
					announcedAddress: '',
				},
				ipv6: {
					enabled: true,
					bindAddress: '',
					announcedAddress: '',
				},
			},
			{
				isProduction: false,
				publicIps: {},
			},
		);

		expect(listenInfos).toHaveLength(4);
		expect(listenInfos[0]?.ip).toBe('127.0.0.1');
		expect(listenInfos[2]?.ip).toBe('::1');
	});
});
