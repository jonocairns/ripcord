import { readdir, readFile } from 'node:fs/promises';

const logDirectory = new URL('../.runtime/data/logs/', import.meta.url);

// Winston's tailable rotation keeps app.log current and app1.log newest archive.
// Include retained archives so a rotation doesn't erase an E2E incident timeline.
export const readServerLog = async (directory = logDirectory): Promise<string> => {
	const files = (await readdir(directory)).filter((name) => /^app\d*\.log$/.test(name));
	files.sort((a, b) => Number(b.slice(3, -4)) - Number(a.slice(3, -4)));
	const contents = await Promise.all(
		files.map(async (name) => {
			try {
				return await readFile(new URL(name, directory), 'utf8');
			} catch (error) {
				if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
				throw error;
			}
		}),
	);
	return contents.join('\n');
};
