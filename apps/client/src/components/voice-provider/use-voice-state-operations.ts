import { useRef } from 'react';
import { sendOwnVoiceStateUpdate, updateOwnVoiceState } from '@/features/server/voice/actions';
import { updateVoiceReconnectIntentState } from '@/features/server/voice/reconnect-coordinator';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { createVoiceStateOperations } from './voice-state-operation';

const useVoiceStateOperations = (currentVoiceChannelId: number | undefined) => {
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const operationsRef = useRef<ReturnType<typeof createVoiceStateOperations> | undefined>(undefined);
	if (!operationsRef.current) {
		operationsRef.current = createVoiceStateOperations({
			getCurrentVoiceChannelId: () => currentVoiceChannelIdRef.current,
			updateOwnVoiceState,
			updateReconnectIntent: updateVoiceReconnectIntentState,
			sendOwnVoiceStateUpdate,
			log: logVoice,
		});
	}
	return operationsRef.current;
};

export { useVoiceStateOperations };
