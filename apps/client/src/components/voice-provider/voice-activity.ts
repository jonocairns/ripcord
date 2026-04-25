export type VoiceActivity = {
	isSpeaking: boolean;
};

export type VoiceActivityStore = {
	subscribe: (listener: () => void) => () => void;
	getUserActivity: (userId: number) => VoiceActivity;
	setUserActivity: (userId: number, activity: VoiceActivity) => void;
	clearUserActivity: (userId: number) => void;
	clearAll: () => void;
};

const EMPTY_VOICE_ACTIVITY: VoiceActivity = {
	isSpeaking: false,
};

const createVoiceActivityStore = (): VoiceActivityStore => {
	const listeners = new Set<() => void>();
	const activities = new Map<number, VoiceActivity>();

	const emit = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		getUserActivity: (userId) => {
			return activities.get(userId) ?? EMPTY_VOICE_ACTIVITY;
		},
		setUserActivity: (userId, activity) => {
			const previous = activities.get(userId);

			if (previous?.isSpeaking === activity.isSpeaking) {
				return;
			}

			activities.set(userId, activity);
			emit();
		},
		clearUserActivity: (userId) => {
			if (!activities.has(userId)) {
				return;
			}

			activities.delete(userId);
			emit();
		},
		clearAll: () => {
			if (activities.size === 0) {
				return;
			}

			activities.clear();
			emit();
		},
	};
};

export { createVoiceActivityStore, EMPTY_VOICE_ACTIVITY };
