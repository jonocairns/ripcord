import { useRef } from 'react';
import { cancelOwnPushHold, setOwnVoiceIntent } from '@/features/server/voice/actions';
import { createVoiceStateOperations } from './voice-state-operation';

const useVoiceStateOperations = () => {
	const ref = useRef<ReturnType<typeof createVoiceStateOperations> | undefined>(undefined);
	if (!ref.current) ref.current = createVoiceStateOperations({ setOwnVoiceIntent, cancelPushHold: cancelOwnPushHold });
	return ref.current;
};

export { useVoiceStateOperations };
