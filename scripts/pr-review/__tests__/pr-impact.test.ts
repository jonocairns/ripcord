import { describe, expect, test } from 'bun:test';
import { Project } from 'ts-morph';
import { analyzeFile } from '../pr-impact';

describe('TypeScript impact analysis', () => {
	test('distinguishes references from direct calls', () => {
		const project = new Project({ useInMemoryFileSystem: true });
		const exported = project.createSourceFile(
			'/repo/exported.ts',
			'export function createThing(input: { userId?: number }): number { return input.userId ?? 0; }',
		);
		project.createSourceFile(
			'/repo/consumer.ts',
			[
				"import { createThing } from './exported';",
				'const savedReference = createThing;',
				'createThing({ userId: 1 });',
				'void savedReference;',
			].join('\n'),
		);

		const createThing = analyzeFile(exported, '/repo').find((symbol) => symbol.name === 'createThing');

		expect(createThing).toBeDefined();
		expect(createThing?.referenceCount).toBeGreaterThan(createThing?.callCount ?? 0);
		expect(createThing?.callCount).toBe(1);
		expect(createThing?.calls).toEqual([{ file: 'consumer.ts', line: 3 }]);
		expect(createThing?.shape?.keyCounts).toEqual({ userId: 1 });
	});
});
