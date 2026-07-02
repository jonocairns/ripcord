import { describe, expect, it } from 'bun:test';
import { didDefaultInputDeviceChange, resolveDefaultInputGroupId } from '../default-input-device';

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
