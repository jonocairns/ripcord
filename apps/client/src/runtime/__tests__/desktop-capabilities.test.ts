import { describe, expect, it } from 'bun:test';
import type { TLegacyDesktopCapabilities } from '../desktop-capabilities';
import { normalizeDesktopCapabilities } from '../desktop-capabilities';
import type { TDesktopCapabilities } from '../types';

describe('normalizeDesktopCapabilities', () => {
	it('fills in missing compatibility fields for older linux desktop runtimes', () => {
		const capabilities: TLegacyDesktopCapabilities = {
			platform: 'linux',
			systemAudio: 'best-effort',
			perAppAudio: 'best-effort',
			notes: ['Linux audio capture depends on your compositor and PipeWire portal.'],
		};

		const normalized = normalizeDesktopCapabilities(capabilities);

		expect(normalized.globalPushKeybinds).toBe('best-effort');
		expect(normalized.issues).toEqual([]);
		expect(normalized.notes).toEqual(capabilities.notes!);
	});

	it('preserves explicit structured capability fields when present', () => {
		const capabilities: TDesktopCapabilities = {
			platform: 'macos',
			systemAudio: 'unsupported',
			perAppAudio: 'unsupported',
			globalPushKeybinds: 'supported',
			issues: [
				{
					code: 'macos-screen-recording-permission-required',
					affects: ['system-audio', 'per-app-audio'],
					severity: 'error',
					title: 'Screen Recording permission required',
					message: 'Grant Sharkord Screen Recording access in System Settings, then try screen sharing again.',
					guidance: ['Grant Sharkord Screen Recording access in System Settings, then try screen sharing again.'],
				},
			],
			notes: ['macOS system and per-app audio capture use the Rust sidecar and ScreenCaptureKit.'],
		};

		const normalized = normalizeDesktopCapabilities(capabilities);

		expect(normalized).toEqual(capabilities);
	});
});
