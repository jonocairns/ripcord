import { describe, expect, it } from 'bun:test';

const extractModuleImports = (source: string): string[] => {
	const moduleImports: string[] = [];
	const importPattern = /import[\s\S]*?from\s*['"]([^'"]+)['"]/gu;

	for (const match of source.matchAll(importPattern)) {
		const modulePath = match[1];
		if (modulePath !== undefined) {
			moduleImports.push(modulePath);
		}
	}

	return moduleImports;
};

describe('voice session runner layering', () => {
	it('keeps executor construction and registration in the React adapter', async () => {
		const providerSource = await Bun.file(
			new URL('../../../../components/voice-provider/index.tsx', import.meta.url),
		).text();
		const adapterSource = await Bun.file(
			new URL('../../../../components/voice-provider/hooks/use-voice-session-executor.ts', import.meta.url),
		).text();

		expect(providerSource).toContain('useVoiceSessionExecutor({');
		expect(providerSource).not.toContain('createVoiceSessionCommandExecutor');
		expect(providerSource).not.toContain('registerVoiceSessionCommandRunner');
		expect(providerSource).not.toContain('isVoiceSessionExecutorCommand');
		expect(providerSource).not.toContain('TLegacyVoiceSessionCommand');
		expect(adapterSource).toContain('createVoiceSessionCommandExecutor');
		expect(adapterSource).toContain('registerVoiceSessionCommandRunner(executor.execute)');
		expect(adapterSource).not.toContain('LegacyVoiceSessionCommand');
	});

	it('keeps the framework-free executor inside its allowed import layer', async () => {
		const executorSource = await Bun.file(new URL('../voice-session-command-executor.ts', import.meta.url)).text();
		const moduleImports = extractModuleImports(executorSource);

		expect(moduleImports).toEqual(['./reconnect-policy', './voice-session-machine', './voice-session-store']);
	});
});
