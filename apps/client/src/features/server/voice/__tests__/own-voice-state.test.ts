import { expect, it } from 'bun:test';
import { resolveOwnVoiceState } from '../own-voice-state';

for (const micMuted of [false, true])
	for (const soundMuted of [false, true])
		for (const talk of [false, true])
			for (const mute of [false, true])
				for (const micTestActive of [false, true]) {
					it(`resolves intent ${micMuted}/${soundMuted}, hold ${talk}/${mute}, test ${micTestActive}`, () => {
						const wanted = !soundMuted && (talk || !micMuted);
						const transmitting = wanted && !mute && !micTestActive;
						expect(
							resolveOwnVoiceState({ intent: { micMuted, soundMuted }, pushHold: { talk, mute }, micTestActive }),
						).toEqual({
							micWanted: wanted,
							transmitting,
							micMuted: !transmitting,
							soundMuted: soundMuted || micTestActive,
							restingMicMuted: micMuted || soundMuted || micTestActive,
						});
					});
				}
