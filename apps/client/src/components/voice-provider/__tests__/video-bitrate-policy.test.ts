import { describe, expect, it } from 'bun:test';
import { getVideoBitratePolicy, SCREEN_START_KBPS_CAP } from '../video-bitrate-policy';

describe('getVideoBitratePolicy', () => {
	it('uses hardcoded start/max bitrate for common screen combos', () => {
		const fullHd30 = getVideoBitratePolicy({
			profile: 'screen',
			width: 1920,
			height: 1080,
			frameRate: 30,
		});
		const fullHd60 = getVideoBitratePolicy({
			profile: 'screen',
			width: 1920,
			height: 1080,
			frameRate: 60,
		});
		const qhd30 = getVideoBitratePolicy({
			profile: 'screen',
			width: 2560,
			height: 1440,
			frameRate: 30,
		});

		expect(fullHd30).toEqual({ startKbps: 6000, maxKbps: 12000 });
		// 1080p60 / 1440p30 table starts are 9000, trimmed by the screen start cap.
		expect(fullHd60).toEqual({ startKbps: SCREEN_START_KBPS_CAP, maxKbps: 18000 });
		expect(qhd30).toEqual({ startKbps: SCREEN_START_KBPS_CAP, maxKbps: 18000 });
	});

	it('uses hardcoded camera buckets by resolution and frame rate', () => {
		const hd30 = getVideoBitratePolicy({
			profile: 'camera',
			width: 1280,
			height: 720,
			frameRate: 30,
		});
		const fullHd60 = getVideoBitratePolicy({
			profile: 'camera',
			width: 1920,
			height: 1080,
			frameRate: 60,
		});

		expect(hd30).toEqual({ startKbps: 1400, maxKbps: 2500 });
		expect(fullHd60).toEqual({ startKbps: 3500, maxKbps: 7000 });
	});

	it('caps to highest bucket for extreme requests', () => {
		const screenExtreme = getVideoBitratePolicy({
			profile: 'screen',
			width: 7680,
			height: 4320,
			frameRate: 240,
		});
		const cameraExtreme = getVideoBitratePolicy({
			profile: 'camera',
			width: 9999,
			height: 9999,
			frameRate: 240,
		});

		// Screen start bitrates are capped (see SCREEN_START_KBPS_CAP); the
		// ceiling still comes from the highest bucket.
		expect(screenExtreme).toEqual({ startKbps: SCREEN_START_KBPS_CAP, maxKbps: 100000 });
		expect(cameraExtreme).toEqual({ startKbps: 11000, maxKbps: 24000 });
	});

	it('caps high screen-tier start bitrates without touching the ceiling', () => {
		const qhd60 = getVideoBitratePolicy({
			profile: 'screen',
			width: 2560,
			height: 1440,
			frameRate: 60,
		});
		const uhd30 = getVideoBitratePolicy({
			profile: 'screen',
			width: 3840,
			height: 2160,
			frameRate: 30,
		});

		// Table values are 14000 start for both tiers; the cap brings them down
		// while leaving the max ceilings from the table untouched.
		expect(qhd60).toEqual({ startKbps: SCREEN_START_KBPS_CAP, maxKbps: 28000 });
		expect(uhd30).toEqual({ startKbps: SCREEN_START_KBPS_CAP, maxKbps: 30000 });
	});

	it('does not cap camera start bitrates', () => {
		const cameraHigh = getVideoBitratePolicy({
			profile: 'camera',
			width: 3840,
			height: 2160,
			frameRate: 120,
		});

		expect(cameraHigh.startKbps).toBe(11000);
	});

	it('scales only maxKbps per codec, leaving startKbps untouched', () => {
		const base = getVideoBitratePolicy({ profile: 'screen', width: 1920, height: 1080, frameRate: 30 });

		const h264 = getVideoBitratePolicy({ profile: 'screen', width: 1920, height: 1080, frameRate: 30, codec: 'h264' });
		const vp8 = getVideoBitratePolicy({ profile: 'screen', width: 1920, height: 1080, frameRate: 30, codec: 'vp8' });
		const vp9 = getVideoBitratePolicy({ profile: 'screen', width: 1920, height: 1080, frameRate: 30, codec: 'vp9' });
		const av1 = getVideoBitratePolicy({ profile: 'screen', width: 1920, height: 1080, frameRate: 30, codec: 'av1' });

		// startKbps is identical regardless of codec.
		expect(h264.startKbps).toBe(base.startKbps);
		expect(vp8.startKbps).toBe(base.startKbps);
		expect(vp9.startKbps).toBe(base.startKbps);
		expect(av1.startKbps).toBe(base.startKbps);

		// maxKbps is scaled by the per-codec multiplier (base maxKbps = 12000).
		expect(h264.maxKbps).toBe(12000);
		expect(vp8.maxKbps).toBe(13800);
		expect(vp9.maxKbps).toBe(10800);
		expect(av1.maxKbps).toBe(9600);
	});
});
