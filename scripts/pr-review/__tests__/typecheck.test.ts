import { describe, expect, test } from 'bun:test';
import { buildReport } from '../typecheck';

describe('typecheck report', () => {
	test('retains errors in unchanged callers', () => {
		const report = buildReport({
			repoRoot: '/repo',
			cmd: 'bun run check-types',
			exitCode: 1,
			pr: 42,
			changedFiles: ['src/exported.ts'],
			allErrors: [
				{
					file: 'src/exported.ts',
					line: 1,
					col: 1,
					code: 'TS2322',
					message: 'Changed file error',
				},
				{
					file: 'src/unchanged-caller.ts',
					line: 8,
					col: 3,
					code: 'TS2554',
					message: 'Expected 2 arguments, but got 1',
				},
			],
		});

		expect(report.passed).toBeFalse();
		expect(report.totalErrors).toBe(2);
		expect(report.errorsInChangedFiles).toBe(1);
		expect(report.errors.map((error) => error.file)).toEqual(['src/exported.ts', 'src/unchanged-caller.ts']);
	});
});
