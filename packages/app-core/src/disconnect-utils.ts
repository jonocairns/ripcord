import { DisconnectCode } from '@sharkord/shared/src/statics';

const shouldRestoreVoiceAfterDisconnect = (code: number): boolean => {
	return code !== DisconnectCode.KICKED && code !== DisconnectCode.BANNED;
};

const isReconnectPausedDisconnectCode = (code: number): boolean => {
	return (code >= 400 && code < 500) || (code >= DisconnectCode.KICKED && code < DisconnectCode.SERVER_SHUTDOWN);
};

export { isReconnectPausedDisconnectCode, shouldRestoreVoiceAfterDisconnect };
