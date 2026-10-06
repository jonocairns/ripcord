import { describe, expect, it, mock } from 'bun:test';
import { recoverTransportMicrophone, resolveTransportRecoveryMicrophoneAction } from '../transport-recovery-microphone';

const input = (overrides: Partial<Parameters<typeof recoverTransportMicrophone>[0]> = {}) => ({
	recoveryJoined: true,
	micMuted: false,
	canSpeak: true,
	hasCurrentStream: false,
	currentTrackLive: false,
	...overrides,
});

describe('transport recovery microphone boundary', () => {
	it('skips microphone acquisition when a muted fresh rejoin has no live capture', async () => {
		const start = mock(async () => ({ status: 'started' as const }));
		const publishCurrent = mock(async () => {});
		const onStartFailed = mock(() => {});

		await expect(
			recoverTransportMicrophone(input({ micMuted: true }), {
				start,
				publishCurrent,
				onStartFailed,
			}),
		).resolves.toBe('skipped');
		expect(start).not.toHaveBeenCalled();
		expect(publishCurrent).not.toHaveBeenCalled();
		expect(onStartFailed).not.toHaveBeenCalled();
	});

	it('continues listen-only and commits terminal mute when an unmuted restart fails', async () => {
		const error = new Error('microphone unavailable');
		const onStartFailed = mock(() => {});

		await expect(
			recoverTransportMicrophone(input(), {
				start: async () => ({ status: 'failed', error }),
				publishCurrent: async () => {},
				onStartFailed,
			}),
		).resolves.toBe('continued-muted');
		expect(onStartFailed).toHaveBeenCalledTimes(1);
		expect(onStartFailed).toHaveBeenCalledWith(error);
	});

	it('reports supersession so stale recovery still aborts', async () => {
		await expect(
			recoverTransportMicrophone(input(), {
				start: async () => ({ status: 'superseded' }),
				publishCurrent: async () => {},
				onStartFailed: () => {},
			}),
		).resolves.toBe('superseded');
	});

	it('preserves a live current capture without reacquiring it', async () => {
		const publishCurrent = mock(async () => {});

		await expect(
			recoverTransportMicrophone(input({ recoveryJoined: false, hasCurrentStream: true, currentTrackLive: true }), {
				start: async () => ({ status: 'started' }),
				publishCurrent,
				onStartFailed: () => {},
			}),
		).resolves.toBe('published-current');
		expect(publishCurrent).toHaveBeenCalledTimes(1);
	});

	it('does not plan reacquisition for a muted ended capture', () => {
		expect(
			resolveTransportRecoveryMicrophoneAction({
				...input({ recoveryJoined: false, micMuted: true, hasCurrentStream: true }),
				canStart: true,
			}),
		).toBe('skip');
	});
});
