type TOwnVoiceIntent = { micMuted: boolean; soundMuted: boolean };
type TOwnPushHold = { talk: boolean; mute: boolean };
const resolveOwnVoiceState = ({
	intent,
	micTestActive,
	pushHold,
}: {
	intent: TOwnVoiceIntent;
	micTestActive: boolean;
	pushHold: TOwnPushHold;
}) => {
	const soundMuted = intent.soundMuted || micTestActive;
	const micWanted = !intent.soundMuted && (pushHold.talk || !intent.micMuted);
	const transmitting = micWanted && !pushHold.mute && !micTestActive;
	return {
		soundMuted,
		micWanted,
		transmitting,
		micMuted: !transmitting,
		restingMicMuted: intent.micMuted || soundMuted,
	};
};

export { resolveOwnVoiceState, type TOwnPushHold, type TOwnVoiceIntent };
