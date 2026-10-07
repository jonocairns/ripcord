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
			new URL('../../../../components/voice-provider/session/use-voice-session-executor.ts', import.meta.url),
		).text();

		const runtimeHookSource = await Bun.file(
			new URL('../../../../components/voice-provider/session/use-voice-session-runtime.ts', import.meta.url),
		).text();
		const runtimeSource = await Bun.file(
			new URL('../../../../components/voice-provider/session/voice-session-runtime.ts', import.meta.url),
		).text();
		expect(runtimeHookSource).toContain('useVoiceSessionExecutor({');
		const environmentSource = await Bun.file(
			new URL('../../../../components/voice-provider/session/voice-session-runtime-environment.ts', import.meta.url),
		).text();
		const remoteIntegrationSource = await Bun.file(
			new URL('../../../../components/voice-provider/remote-media/remote-media-integration.ts', import.meta.url),
		).text();
		const remoteHookSource = await Bun.file(
			new URL('../../../../components/voice-provider/remote-media/use-remote-media.ts', import.meta.url),
		).text();
		for (const source of [
			runtimeSource,
			runtimeHookSource,
			environmentSource,
			remoteIntegrationSource,
			remoteHookSource,
		]) {
			expect(source).not.toContain('createVoiceSessionCommandExecutor');
			expect(source).not.toContain('registerVoiceSessionCommandRunner');
			expect(source).not.toContain('isVoiceSessionExecutorCommand');
			expect(source).not.toContain('TLegacyVoiceSessionCommand');
		}
		expect(extractModuleImports(runtimeSource)).not.toContain('react');
		expect(extractModuleImports(remoteIntegrationSource)).not.toContain('react');
		expect(remoteHookSource).toContain('useRemoteMediaSubscriptions()');
		expect(remoteHookSource).toContain('useRemoteMediaConsumeRunner({');
		expect(remoteHookSource).toContain('useRemoteMediaRepairRunner({');
		expect(remoteHookSource).toContain('useTransports({');
		expect(remoteHookSource).toContain('useVoiceEvents({');
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
