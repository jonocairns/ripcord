import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';

// bun:sqlite transactions commit as soon as the callback returns, so an async
// callback commits at its first await and the rest runs with no rollback.
const ASYNC_TRANSACTION_PATTERN = /\.transaction\s*(<[^>]*>)?\(\s*async\b/;

test('SQLite transactions use synchronous callbacks', async () => {
	const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
	const matches: string[] = [];
	for await (const path of new Glob('**/*.ts').scan({ cwd: sourceRoot })) {
		if (path.split(sep).includes('__tests__')) continue;
		const source = await readFile(join(sourceRoot, path), 'utf8');
		if (ASYNC_TRANSACTION_PATTERN.test(source)) matches.push(path);
	}
	expect(matches.sort()).toEqual([]);
});
