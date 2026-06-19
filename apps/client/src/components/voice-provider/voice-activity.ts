export type VoiceActivity = {
	isSpeaking: boolean;
};

export type VoiceActivityStore = {
	subscribe: (listener: () => void) => () => void;
	getUserActivity: (userId: number) => VoiceActivity;
	setServerUserActivity: (userId: number, activity: VoiceActivity) => void;
	setLocalUserActivity: (userId: number, isSpeaking: boolean | undefined) => void;
	clearUserActivity: (userId: number) => void;
	clearAll: () => void;
};

type VoiceActivitySources = {
	serverSpeaking: boolean;
	localSpeaking: boolean | undefined;
};

const EMPTY_VOICE_ACTIVITY: VoiceActivity = {
	isSpeaking: false,
};

const createVoiceActivityStore = (): VoiceActivityStore => {
	const listeners = new Set<() => void>();
	const activities = new Map<number, VoiceActivity>();
	const sources = new Map<number, VoiceActivitySources>();

	const emit = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	const updateActivity = (userId: number, updateSources: (current: VoiceActivitySources) => VoiceActivitySources) => {
		const currentSources = sources.get(userId) ?? {
			serverSpeaking: false,
			localSpeaking: undefined,
		};
		const nextSources = updateSources(currentSources);
		const previousIsSpeaking = currentSources.localSpeaking ?? currentSources.serverSpeaking;
		const nextIsSpeaking = nextSources.localSpeaking ?? nextSources.serverSpeaking;

		sources.set(userId, nextSources);

		if (previousIsSpeaking === nextIsSpeaking) {
			return;
		}

		activities.set(userId, {
			isSpeaking: nextIsSpeaking,
		});
		emit();
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
		setServerUserActivity: (userId, activity) =>
			updateActivity(userId, (current) => ({
				...current,
				serverSpeaking: activity.isSpeaking,
			})),
		setLocalUserActivity: (userId, isSpeaking) =>
			updateActivity(userId, (current) => ({
				...current,
				localSpeaking: isSpeaking,
			})),
		clearUserActivity: (userId) => {
			if (!sources.has(userId)) {
				return;
			}

			sources.delete(userId);
			activities.delete(userId);
			emit();
		},
		clearAll: () => {
			if (sources.size === 0) {
				return;
			}

			sources.clear();
			activities.clear();
			emit();
		},
	};
};

export { createVoiceActivityStore, EMPTY_VOICE_ACTIVITY };
