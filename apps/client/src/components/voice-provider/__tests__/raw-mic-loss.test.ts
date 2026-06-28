import { describe, expect, it } from 'bun:test';
import { resolveRawMicLossAction, type TRawMicLossInput } from '../raw-mic-loss';

const liveCaptureLoss = (overrides: Partial<TRawMicLossInput> = {}): TRawMicLossInput => ({
	reason: 'mute',
	superseded: false,
	inChannel: true,
	micMuted: false,
	trackStillMuted: true,
	...overrides,
});

describe('raw mic loss', () => {
	it('re-acquires when an unmuted in-channel capture is interrupted by a sustained mute', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ reason: 'mute', trackStillMuted: true }))).toBe('recover');
	});

	it('re-acquires when an unmuted in-channel capture ends (device removed)', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ reason: 'ended' }))).toBe('recover');
	});

	it('ignores a mute that self-healed before the settle window elapsed', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ reason: 'mute', trackStillMuted: false }))).toBe('ignore');
	});

	it('still acts on `ended` regardless of the muted flag, since ended is permanent', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ reason: 'ended', trackStillMuted: false }))).toBe('recover');
	});

	it('ignores loss on a capture that has been superseded by a newer one', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ superseded: true }))).toBe('ignore');
		expect(resolveRawMicLossAction(liveCaptureLoss({ superseded: true, reason: 'ended' }))).toBe('ignore');
	});

	it('ignores loss when no longer in a channel (leave flow owns teardown)', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ inChannel: false }))).toBe('ignore');
		expect(resolveRawMicLossAction(liveCaptureLoss({ inChannel: false, reason: 'ended' }))).toBe('ignore');
	});

	it('tears down for the next unmute when interrupted while the user is muted', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ micMuted: true }))).toBe('teardown-for-unmute');
		expect(resolveRawMicLossAction(liveCaptureLoss({ micMuted: true, reason: 'ended' }))).toBe('teardown-for-unmute');
	});

	it('prioritises supersession over the muted-teardown path', () => {
		expect(resolveRawMicLossAction(liveCaptureLoss({ superseded: true, micMuted: true }))).toBe('ignore');
	});
});
