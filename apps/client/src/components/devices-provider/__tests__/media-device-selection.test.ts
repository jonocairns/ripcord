import { describe, expect, it } from 'bun:test';
import { getStoredMediaDeviceMetadata, normalizeStoredMediaDeviceId } from '../media-device-selection';

const createMediaDevice = ({
	deviceId,
	groupId = '',
	kind = 'audioinput',
	label = '',
}: {
	deviceId: string;
	groupId?: string;
	kind?: MediaDeviceKind;
	label?: string;
}): MediaDeviceInfo => {
	return {
		deviceId,
		groupId,
		kind,
		label,
		toJSON: () => ({
			deviceId,
			groupId,
			kind,
			label,
		}),
	};
};

describe('media-device-selection', () => {
	it('keeps the exact saved device id when it is still available', () => {
		const devices = [createMediaDevice({ deviceId: 'mic-1', groupId: 'group-a', label: 'USB Mic' })];

		expect(
			normalizeStoredMediaDeviceId('mic-1', devices, {
				groupId: 'group-a',
				label: 'USB Mic',
			}),
		).toBe('mic-1');
	});

	it('remaps a saved device to the current id using groupId', () => {
		const devices = [createMediaDevice({ deviceId: 'mic-next', groupId: 'group-a', label: 'USB Mic' })];

		expect(
			normalizeStoredMediaDeviceId('mic-old', devices, {
				groupId: 'group-a',
				label: 'USB Mic',
			}),
		).toBe('mic-next');
	});

	it('remaps a saved device to the current id using a unique label fallback', () => {
		const devices = [createMediaDevice({ deviceId: 'mic-next', label: 'USB Mic' })];

		expect(
			normalizeStoredMediaDeviceId('mic-old', devices, {
				groupId: undefined,
				label: 'USB Mic',
			}),
		).toBe('mic-next');
	});

	it('avoids ambiguous label matches', () => {
		const devices = [
			createMediaDevice({ deviceId: 'mic-a', label: 'USB Mic' }),
			createMediaDevice({ deviceId: 'mic-b', label: 'USB Mic' }),
		];

		expect(
			normalizeStoredMediaDeviceId('mic-old', devices, {
				groupId: undefined,
				label: 'USB Mic',
			}),
		).toBeUndefined();
	});

	it('captures the current device metadata for later remapping', () => {
		const devices = [createMediaDevice({ deviceId: 'mic-1', groupId: 'group-a', label: ' USB Mic ' })];

		expect(getStoredMediaDeviceMetadata('mic-1', devices)).toEqual({
			groupId: 'group-a',
			label: 'USB Mic',
		});
	});
});
