import { createHash } from 'node:crypto';

// Shipped clients compare kicks against the legacy, invalid 40000 close code
// and treat the valid 4000 replacement as recoverable. Keep their automatic
// restore blocked for the lifetime of a voice reconnect intent; manual joins
// clear the guard as soon as they succeed.
const VOICE_KICK_RESTORE_BLOCK_MS = 60_000;

type TVoiceKickGuardIdentity = {
	clientInstanceId?: string;
	token?: string;
};

type TVoiceKickRestoreBlock = {
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
};

const blockedVoiceRestores = new Map<string, TVoiceKickRestoreBlock>();

const getVoiceKickRestoreKey = (userId: number, identity: TVoiceKickGuardIdentity) => {
	if (identity.clientInstanceId) {
		return `${userId}:client:${identity.clientInstanceId}`;
	}

	if (identity.token) {
		const tokenHash = createHash('sha256').update(identity.token).digest('hex');
		return `${userId}:token:${tokenHash}`;
	}

	return undefined;
};

const getVoiceKickGuardIdentity = (connection: unknown): TVoiceKickGuardIdentity => {
	if (typeof connection !== 'object' || connection === null) {
		return {};
	}

	const clientInstanceId = Reflect.get(connection, 'clientInstanceId');
	const token = Reflect.get(connection, 'token');

	return {
		clientInstanceId:
			typeof clientInstanceId === 'string' && clientInstanceId.length > 0 ? clientInstanceId : undefined,
		token: typeof token === 'string' && token.length > 0 ? token : undefined,
	};
};

const blockVoiceRestoreAfterKick = (
	userId: number,
	identity: TVoiceKickGuardIdentity,
	ttlMs = VOICE_KICK_RESTORE_BLOCK_MS,
) => {
	const key = getVoiceKickRestoreKey(userId, identity);

	if (!key) {
		return false;
	}

	const existingBlock = blockedVoiceRestores.get(key);

	if (existingBlock) {
		clearTimeout(existingBlock.timer);
	}

	const expiresAt = Date.now() + ttlMs;
	const timer = setTimeout(() => {
		const currentBlock = blockedVoiceRestores.get(key);

		if (currentBlock?.expiresAt === expiresAt) {
			blockedVoiceRestores.delete(key);
		}
	}, ttlMs);

	timer.unref();
	blockedVoiceRestores.set(key, { expiresAt, timer });

	return true;
};

const isVoiceRestoreBlockedAfterKick = (userId: number, identity: TVoiceKickGuardIdentity) => {
	const key = getVoiceKickRestoreKey(userId, identity);

	if (!key) {
		return false;
	}

	const block = blockedVoiceRestores.get(key);

	if (!block) {
		return false;
	}

	if (block.expiresAt <= Date.now()) {
		clearTimeout(block.timer);
		blockedVoiceRestores.delete(key);
		return false;
	}

	return true;
};

const clearVoiceRestoreBlockAfterKick = (userId: number, identity: TVoiceKickGuardIdentity) => {
	const key = getVoiceKickRestoreKey(userId, identity);

	if (!key) {
		return false;
	}

	const block = blockedVoiceRestores.get(key);

	if (!block) {
		return false;
	}

	clearTimeout(block.timer);
	blockedVoiceRestores.delete(key);
	return true;
};

const resetVoiceKickGuardsForTests = () => {
	blockedVoiceRestores.forEach((block) => {
		clearTimeout(block.timer);
	});
	blockedVoiceRestores.clear();
};

export {
	blockVoiceRestoreAfterKick,
	clearVoiceRestoreBlockAfterKick,
	getVoiceKickGuardIdentity,
	isVoiceRestoreBlockedAfterKick,
	resetVoiceKickGuardsForTests,
	type TVoiceKickGuardIdentity,
	VOICE_KICK_RESTORE_BLOCK_MS,
};
