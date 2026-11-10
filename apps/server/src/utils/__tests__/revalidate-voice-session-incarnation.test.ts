import { afterEach, expect, test } from 'bun:test';
import { ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { tdb } from '../../__tests__/setup';
import { rolePermissions } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../pubsub';
import { revalidateActiveVoiceSessions } from '../revalidate-voice-sessions';

const state = { micMuted: false, soundMuted: false };

afterEach(async () => {
	const runtime = VoiceRuntime.findById(2);
	if (runtime) await runtime.destroy();
});

test('deferred revalidation preserves a replacement seat and publishes no stale leave', async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	await tdb.delete(rolePermissions).where(eq(rolePermissions.roleId, 2));
	runtime.addUser(2, state);
	const oldIncarnation = runtime.getVoiceSessionIncarnation(2);
	const leaves: unknown[] = [];
	const subscription = pubsub.subscribeFor(2, ServerEvents.USER_LEAVE_VOICE).subscribe({ next: (e) => leaves.push(e) });
	try {
		// Revalidation snapshots the seat and suspends at its permission await.
		// Replace the seat before allowing that continuation to remove anything.
		const pending = revalidateActiveVoiceSessions({ userIds: [2] });
		runtime.removeUser(2);
		runtime.addUser(2, state);
		const newIncarnation = runtime.getVoiceSessionIncarnation(2);
		expect(newIncarnation).toBeDefined();
		expect(newIncarnation).not.toBe(oldIncarnation);
		await pending;
		expect(runtime.getVoiceSessionIncarnation(2)).toBe(newIncarnation);
		expect(runtime.getUser(2)).toBeDefined();
		expect(leaves).toEqual([]);
	} finally {
		subscription.unsubscribe();
	}
});
