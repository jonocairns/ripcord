import { afterEach, describe, expect, test } from 'bun:test';
import { VoiceRuntime } from '../voice';
import { CLIENT_VOICE_ACTIVITY_LEASE_MS } from '../voice-activity-lease';

/**
 * Tests for the client-authoritative speaking relay.
 *
 * Newer clients report their own speaking transitions via
 * applyClientVoiceActivity(); the runtime relays them and snapshots
 * getSpeakingUserIds() for late subscribers. The pure accept/reject rules live
 * in voice-activity-lease.ts (and are unit tested there); these lock down the
 * runtime wiring: producer binding, mute, and sequence ordering.
 */

const CHANNEL_BASE = 95_000;
let channelCounter = 0;

const nextChannelId = () => CHANNEL_BASE + ++channelCounter;
const wait = (durationMs: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, durationMs);
	});

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

	// `applyClientVoiceActivity` only accepts a `true` for a user with a live mic
	// producer. Stub the private producer map rather than driving a full produce
	// flow, since the relay logic only checks for presence.
	const audioProducerMap = (runtime: VoiceRuntime): Record<number, unknown> =>
		(runtime as unknown as { audioProducers: Record<number, unknown> }).audioProducers;

	const producerIdFor = (userId: number) => `producer-${userId}`;

	const attachAudioProducer = (runtime: VoiceRuntime, userId: number) => {
		// Minimal stand-in: removeProducer() calls close() during teardown, and the
		// relay only reads the producer id.
		audioProducerMap(runtime)[userId] = { id: producerIdFor(userId), closed: false, close: () => {} };
	};

	const detachAudioProducer = (runtime: VoiceRuntime, userId: number) => {
		delete audioProducerMap(runtime)[userId];
	};

	const observerSpeakingUserIds = (runtime: VoiceRuntime): Set<number> =>
		(runtime as unknown as { observerSpeakingUserIds: Set<number> }).observerSpeakingUserIds;

	test('reflects a joined user’s reported speaking state', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).toContain(1);

		runtime.applyClientVoiceActivity(1, false, 2, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('ignores a report when the user has no active audio producer', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('ignores a report bound to a different producer than the current one', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 1, 'stale-producer');
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('ignores a true report from a muted user', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: true, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('a stray true after the audio producer closed does not resurrect the ring', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).toContain(1);

		// Producer closes: a definite `false` clears the ring, then the producer
		// is gone. An in-flight `true` arriving afterwards must be ignored.
		runtime.applyClientVoiceActivity(1, false, 2, producerIdFor(1));
		detachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 3, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('ignores reports for a user who is not in the channel', async () => {
		const runtime = await makeRuntime();

		runtime.applyClientVoiceActivity(42, true, 1, producerIdFor(42));
		expect(runtime.getSpeakingUserIds()).not.toContain(42);
	});

	test('drops a reordered report with a stale sequence number', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		// A newer `true` (seq 2) arrives before an older `false` (seq 1).
		runtime.applyClientVoiceActivity(1, true, 2, producerIdFor(1));
		runtime.applyClientVoiceActivity(1, false, 1, producerIdFor(1));

		expect(runtime.getSpeakingUserIds()).toContain(1);

		// A genuinely newer `false` still wins.
		runtime.applyClientVoiceActivity(1, false, 3, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);
	});

	test('actively reconciles to retained observer state when the client lease expires', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).toContain(1);

		// No later observer event is required: expiry itself must apply the
		// retained observer state (silence here) and clear the client-driven ring.
		await wait(CLIENT_VOICE_ACTIVITY_LEASE_MS + 50);
		expect(runtime.getSpeakingUserIds()).not.toContain(1);

		// Expiring authority must not discard ordering. A delayed duplicate from
		// the same producer remains stale after expiry.
		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);

		// Retained observer speech is likewise applied when a newer client false
		// lease expires.
		observerSpeakingUserIds(runtime).add(1);
		runtime.applyClientVoiceActivity(1, false, 2, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).not.toContain(1);

		await wait(CLIENT_VOICE_ACTIVITY_LEASE_MS + 50);
		expect(runtime.getSpeakingUserIds()).toContain(1);
	});

	test('a fresh producer after leave/rejoin is accepted despite a low sequence', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);

		runtime.applyClientVoiceActivity(1, true, 9, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).toContain(1);

		runtime.removeUser(1);
		expect(runtime.getSpeakingUserIds()).not.toContain(1);

		// A fresh session starts its counter from a low value again; the first
		// report after rejoining must be accepted as the new baseline.
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		attachAudioProducer(runtime, 1);
		runtime.applyClientVoiceActivity(1, true, 1, producerIdFor(1));
		expect(runtime.getSpeakingUserIds()).toContain(1);
	});
});
