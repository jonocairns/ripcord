import { afterEach, describe, expect, test } from 'bun:test';
import { VoiceRuntime } from '../voice';

/**
 * Tests for the client-authoritative speaking relay.
 *
 * Newer clients report their own speaking transitions via
 * applyClientVoiceActivity(); the runtime relays them and snapshots
 * getSpeakingUserIds() for late subscribers. These lock down the two
 * correctness guarantees that aren't obvious from the happy path:
 *   - reordered fire-and-forget reports are dropped by sequence number
 *   - leaving the channel resets the per-user sequence baseline
 */

const CHANNEL_BASE = 95_000;
let channelCounter = 0;

const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

describe('VoiceRuntime client voice-activity relay', () => {
	const runtimes: VoiceRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes) {
			try {
				await runtime.destroy();
			} catch {
				// ignore — runtime may already be torn down
			}
		}
		runtimes.length = 0;
	});

	const makeRuntime = async (): Promise<VoiceRuntime> => {
		const runtime = new VoiceRuntime(nextChannelId());
		runtimes.push(runtime);
		await runtime.init();
		return runtime;
	};

	test('reflects a joined user’s reported speaking state', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		runtime.applyClientVoiceActivity(1, true, 1);
		expect(runtime.getSpeakingUserIds()).toContain(1);

		runtime.applyClientVoiceActivity(1, false, 2);
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('ignores reports for a user who is not in the channel', async () => {
		const runtime = await makeRuntime();

		runtime.applyClientVoiceActivity(42, true, 1);
		expect(runtime.getSpeakingUserIds()).not.toContain(42);
	});

	test('drops a reordered report with a stale sequence number', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		// A newer `true` (seq 2) arrives before an older `false` (seq 1).
		runtime.applyClientVoiceActivity(1, true, 2);
		runtime.applyClientVoiceActivity(1, false, 1);

		expect(runtime.getSpeakingUserIds()).toContain(1);

		// A genuinely newer `false` still wins.
		runtime.applyClientVoiceActivity(1, false, 3);
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('resets the sequence baseline when the user leaves and rejoins', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		runtime.applyClientVoiceActivity(1, true, 9);
		expect(runtime.getSpeakingUserIds()).toContain(1);

		runtime.removeUser(1);
		expect(runtime.getSpeakingUserIds()).not.toContain(1);

		// A fresh session starts its counter from a low value again; the first
		// report after rejoining must be accepted as the new baseline.
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.applyClientVoiceActivity(1, true, 1);
		expect(runtime.getSpeakingUserIds()).toContain(1);
	});
});
