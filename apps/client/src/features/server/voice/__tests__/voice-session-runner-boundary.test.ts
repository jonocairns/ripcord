import { describe, expect, it } from 'bun:test';

const bannedReconnectFacadeImports = [
	'clearVoiceReconnectRecovery',
	'ensureVoiceReconnectStarted',
	'markVoiceReconnectSessionAuthenticated',
	'markVoiceReconnectSessionUnauthenticated',
	'snapshotVoiceReconnectIntent',
	'captureVoiceReconnectIntentForCurrentSession',
];

const bannedVoiceSessionStoreImports = ['resetVoiceSessionState', 'resetVoiceSessionStoreForTest'];
const bannedReconnectPolicyImports = ['classifyVoiceReconnectError'];

const extractNamedImports = (source: string, modulePath: string): string[] => {
	const importPattern = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${modulePath}['"]`, 'g');
	const imports: string[] = [];

	for (const match of source.matchAll(importPattern)) {
		const importList = match[1];
		if (importList === undefined) {
			continue;
		}

		imports.push(
			...importList
				.split(',')
				.map((importName) =>
					importName
						.trim()
						.split(/\s+as\s+/u)[0]
						?.replace(/^type\s+/u, '')
						.trim(),
				)
				.filter((importName): importName is string => importName !== undefined && importName.length > 0),
		);
	}

	return imports;
};

describe('embedded voice session runner boundary', () => {
	it('does not import legacy reconnect mutators, raw machine reset APIs, or policy classifiers', async () => {
		const providerSource = await Bun.file(
			new URL('../../../../components/voice-provider/index.tsx', import.meta.url),
		).text();

		const reconnectFacadeImports = extractNamedImports(providerSource, '@/features/server/voice/reconnect-coordinator');
		const reconnectPolicyImports = extractNamedImports(providerSource, '@/features/server/voice/reconnect-policy');
		const voiceSessionStoreImports = extractNamedImports(providerSource, '@/features/server/voice/voice-session-store');

		expect(reconnectFacadeImports.filter((importName) => bannedReconnectFacadeImports.includes(importName))).toEqual(
			[],
		);
		expect(
			voiceSessionStoreImports.filter((importName) => bannedVoiceSessionStoreImports.includes(importName)),
		).toEqual([]);
		expect(reconnectPolicyImports.filter((importName) => bannedReconnectPolicyImports.includes(importName))).toEqual(
			[],
		);
	});
});
