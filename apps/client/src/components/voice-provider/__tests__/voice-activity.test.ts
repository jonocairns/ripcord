import { describe, expect, it } from 'bun:test';
import { createVoiceActivityStore, EMPTY_VOICE_ACTIVITY } from '../voice-activity';

describe('createVoiceActivityStore', () => {
	it('returns silence for users without activity', () => {
		const store = createVoiceActivityStore();

		expect(store.getUserActivity(1)).toBe(EMPTY_VOICE_ACTIVITY);
		expect(store.getUserActivity(1).isSpeaking).toBe(false);
	});

	it('notifies subscribers when user activity changes', () => {
		const store = createVoiceActivityStore();
		let updates = 0;

		const unsubscribe = store.subscribe(() => {
			updates += 1;
		});

		store.setUserActivity(1, { isSpeaking: true });
		store.setUserActivity(1, { isSpeaking: true });
		store.setUserActivity(1, { isSpeaking: false });
		unsubscribe();
		store.setUserActivity(1, { isSpeaking: true });

		expect(updates).toBe(2);
		expect(store.getUserActivity(1).isSpeaking).toBe(true);
	});

	it('clears one user or all users', () => {
		const store = createVoiceActivityStore();
		let updates = 0;

		store.subscribe(() => {
			updates += 1;
		});

		store.setUserActivity(1, { isSpeaking: true });
		store.setUserActivity(2, { isSpeaking: true });
		store.clearUserActivity(1);
		store.clearUserActivity(1);
		store.clearAll();
		store.clearAll();

		expect(updates).toBe(4);
		expect(store.getUserActivity(1).isSpeaking).toBe(false);
		expect(store.getUserActivity(2).isSpeaking).toBe(false);
	});
});
