import { describe, expect, it } from 'bun:test';
import { createStreamPlaybackPolicy, type TPlaybackSample } from '../stream-playback-policy';

const sample = (now: number, extra: Partial<TPlaybackSample> = {}): TPlaybackSample => ({
	now,
	eligible: true,
	transportConnected: true,
	framesReceived: 1,
	framesDecoded: 1,
	framesRendered: 1,
	...extra,
});

describe('screen playback evidence', () => {
	it('records a first rendered frame and leaves static screens as ambiguous inactivity', () => {
		const observe = createStreamPlaybackPolicy();
		expect(observe(sample(0)).map((event) => event.event)).toEqual(['playback_first_frame']);
		expect(observe(sample(15_000))).toEqual([]);
		expect(observe(sample(30_000))).toMatchObject([{ event: 'playback_inactive', reason: 'static_or_idle' }]);
		expect(observe(sample(60_000))).toEqual([]);
		expect(observe(sample(63_000, { framesReceived: 2, framesDecoded: 2, framesRendered: 2 }))).toMatchObject([
			{ event: 'playback_recovered' },
		]);
	});
	it('keeps an incoming-but-undecoded diagnosis until decoded frames actually progress', () => {
		const observe = createStreamPlaybackPolicy();
		observe(sample(0));
		for (let second = 3; second <= 15; second += 3)
			expect(observe(sample(second * 1000, { framesReceived: second }))).toEqual([]);
		expect(observe(sample(18_000, { framesReceived: 18 }))).toMatchObject([
			{ event: 'playback_stalled', reason: 'no_decoding' },
		]);
		for (let second = 21; second <= 36; second += 3)
			expect(observe(sample(second * 1000, { framesReceived: second }))).toEqual([]);
		expect(observe(sample(39_000, { framesReceived: 39, framesDecoded: 2, framesRendered: 2 }))).toMatchObject([
			{ event: 'playback_recovered' },
		]);
	});
	it('distinguishes a stuck visible renderer from an unsupported renderer counter', () => {
		const observe = createStreamPlaybackPolicy();
		observe(sample(0));
		for (let second = 3; second <= 15; second += 3)
			observe(sample(second * 1000, { framesReceived: second, framesDecoded: second }));
		expect(observe(sample(18_000, { framesReceived: 18, framesDecoded: 18 }))).toMatchObject([
			{ event: 'playback_stalled', reason: 'no_playback' },
		]);
		expect(observe(sample(21_000, { framesReceived: 21, framesDecoded: 21 }))).toEqual([]);
		expect(observe(sample(24_000, { framesReceived: 24, framesDecoded: 24, framesRendered: 2 }))).toMatchObject([
			{ event: 'playback_recovered' },
		]);
		const unsupported = createStreamPlaybackPolicy();
		for (let second = 0; second <= 60; second += 3)
			expect(
				unsupported(
					sample(second * 1000, { framesReceived: second, framesDecoded: second, framesRendered: undefined }),
				),
			).toEqual([]);
	});
	for (const stage of ['no_decoding', 'no_playback'] as const) {
		it(`retains ${stage} across source inactivity and upstream-only progress`, () => {
			const observe = createStreamPlaybackPolicy();
			const counters = (value: number) => ({
				framesReceived: value,
				framesDecoded: stage === 'no_playback' ? value : 1,
				framesRendered: 1,
			});
			observe(sample(0));
			for (let second = 3; second <= 15; second += 3) observe(sample(second * 1000, counters(second)));
			expect(observe(sample(18_000, counters(18)))).toMatchObject([{ event: 'playback_stalled', reason: stage }]);
			// The source stops, then resumes, while the diagnosed stage stays stuck.
			expect(observe(sample(48_000, counters(18)))).toEqual([]);
			expect(observe(sample(51_000, counters(19)))).toEqual([]);
			expect(observe(sample(54_000, { framesReceived: 20, framesDecoded: 20, framesRendered: 2 }))).toMatchObject([
				{ event: 'playback_recovered' },
			]);
		});
	}
	for (const stage of ['no_decoding', 'no_playback'] as const) {
		it(`diagnoses ${stage} when the screen advances every six seconds`, () => {
			const observe = createStreamPlaybackPolicy();
			observe(sample(0));
			for (let second = 3; second <= 18; second += 3) {
				const frames = Math.floor(second / 6) + 1;
				expect(
					observe(
						sample(second * 1000, {
							framesReceived: frames,
							framesDecoded: stage === 'no_playback' ? frames : 1,
						}),
					),
				).toEqual([]);
			}
			expect(
				observe(
					sample(21_000, {
						framesReceived: 4,
						framesDecoded: stage === 'no_playback' ? 4 : 1,
					}),
				),
			).toMatchObject([{ event: 'playback_stalled', reason: stage }]);
			expect(observe(sample(24_000, { framesReceived: 5, framesDecoded: 5, framesRendered: 2 }))).toMatchObject([
				{ event: 'playback_recovered' },
			]);
		});
	}
	it('clears undiagnosed blocked-stage evidence after source inactivity', () => {
		const observe = createStreamPlaybackPolicy();
		observe(sample(0));
		expect(observe(sample(6_000, { framesReceived: 2 }))).toEqual([]);
		expect(observe(sample(36_000, { framesReceived: 2 }))).toMatchObject([
			{ event: 'playback_inactive', reason: 'static_or_idle' },
		]);
		expect(observe(sample(42_000, { framesReceived: 3 }))).toMatchObject([{ event: 'playback_recovered' }]);
	});
	it('suppresses paused, hidden and detached samples and distinguishes disconnected inactivity', () => {
		const observe = createStreamPlaybackPolicy();
		observe(sample(0));
		for (let second = 3; second <= 60; second += 3)
			expect(observe(sample(second * 1000, { eligible: false }))).toEqual([]);
		expect(observe(sample(63_000, { transportConnected: false }))).toEqual([]);
		expect(observe(sample(93_000, { transportConnected: false }))).toMatchObject([
			{ event: 'playback_inactive', reason: 'no_incoming_media' },
		]);
	});
});
