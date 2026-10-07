import { describe, expect, it } from 'bun:test';
import {
	didDefaultInputDeviceChange,
	resolveDefaultInputGroupId,
	resolveDefaultInputRecoveryDecision,
} from '../default-input-device';

describe('resolveDefaultInputGroupId', () => {
	it('returns the groupId of the synthetic default entry', () => {
		const groupId = resolveDefaultInputGroupId([
			{ deviceId: 'default', groupId: 'group-broadcast' },
			{ deviceId: 'yeti-id', groupId: 'group-yeti' },
			{ deviceId: 'broadcast-id', groupId: 'group-broadcast' },
		]);

		expect(groupId).toBe('group-broadcast');
	});

	it('ignores a default entry with an empty groupId', () => {
		expect(resolveDefaultInputGroupId([{ deviceId: 'default', groupId: '' }])).toBeUndefined();
	});

	it('returns undefined when there is no default entry', () => {
		expect(resolveDefaultInputGroupId([{ deviceId: 'yeti-id', groupId: 'group-yeti' }])).toBeUndefined();
	});
});

describe('didDefaultInputDeviceChange', () => {
	it('re-acquires when the system default moved to a different device', () => {
		expect(didDefaultInputDeviceChange({ capturedGroupId: 'group-yeti', defaultGroupId: 'group-broadcast' })).toBe(
			true,
		);
	});

	it('does nothing when the default still matches the captured device', () => {
		expect(didDefaultInputDeviceChange({ capturedGroupId: 'group-yeti', defaultGroupId: 'group-yeti' })).toBe(false);
	});

	it('does nothing when the captured group is unknown', () => {
		expect(didDefaultInputDeviceChange({ capturedGroupId: undefined, defaultGroupId: 'group-broadcast' })).toBe(false);
	});

	it('does nothing when the default group is unresolvable', () => {
		expect(didDefaultInputDeviceChange({ capturedGroupId: 'group-yeti', defaultGroupId: undefined })).toBe(false);
	});
});

describe('resolveDefaultInputRecoveryDecision', () => {
	it('re-acquires an unmuted microphone for a new default-device move', () => {
		expect(
			resolveDefaultInputRecoveryDecision({
				capturedGroupId: 'group-yeti',
				defaultGroupId: 'group-broadcast',
				micMuted: false,
				handledMove: undefined,
			}),
		).toEqual({
			action: 'reacquire',
			handledMove: {
				capturedGroupId: 'group-yeti',
				defaultGroupId: 'group-broadcast',
			},
		});
	});

	it('tears down a muted microphone without immediately republishing it', () => {
		expect(
			resolveDefaultInputRecoveryDecision({
				capturedGroupId: 'group-yeti',
				defaultGroupId: 'group-broadcast',
				micMuted: true,
				handledMove: undefined,
			}),
		).toEqual({
			action: 'teardown-for-unmute',
			handledMove: {
				capturedGroupId: 'group-yeti',
				defaultGroupId: 'group-broadcast',
			},
		});
	});

	it('ignores repeated reports of the same unresolved move', () => {
		const handledMove = {
			capturedGroupId: 'group-yeti',
			defaultGroupId: 'group-broadcast',
		};

		expect(
			resolveDefaultInputRecoveryDecision({
				...handledMove,
				micMuted: false,
				handledMove,
			}),
		).toEqual({ action: 'ignore-duplicate', handledMove });
	});

	it('allows a future move after capture catches up to the default', () => {
		expect(
			resolveDefaultInputRecoveryDecision({
				capturedGroupId: 'group-broadcast',
				defaultGroupId: 'group-broadcast',
				micMuted: false,
				handledMove: {
					capturedGroupId: 'group-yeti',
					defaultGroupId: 'group-broadcast',
				},
			}),
		).toEqual({ action: 'wait', handledMove: undefined });
	});

	it('preserves deduplication state while device identities are unavailable', () => {
		const handledMove = {
			capturedGroupId: 'group-yeti',
			defaultGroupId: 'group-broadcast',
		};

		expect(
			resolveDefaultInputRecoveryDecision({
				capturedGroupId: undefined,
				defaultGroupId: 'group-broadcast',
				micMuted: false,
				handledMove,
			}),
		).toEqual({ action: 'wait', handledMove });
	});
});
