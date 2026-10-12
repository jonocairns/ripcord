import { readdir, readFile, stat } from 'node:fs/promises';

const logDirectory = new URL('../.runtime/data/logs/', import.meta.url);

// Winston's tailable rotation keeps app.log current and app1.log newest archive.
// Include retained archives so a rotation doesn't erase an E2E incident timeline.
export const readServerLog = async (
	directory = logDirectory,
	read = (file: URL): Promise<string> => readFile(file, 'utf8'),
): Promise<string> => {
	const snapshot = async () => {
		const files = (await readdir(directory)).filter((name) => /^app\d*\.log$/.test(name));
		files.sort((a, b) => Number(b.slice(3, -4)) - Number(a.slice(3, -4)));
		return Promise.all(
			files.map(async (name) => {
				const { dev, ino } = await stat(new URL(name, directory));
				return { name, dev, ino };
			}),
		);
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const before = await snapshot();
			const contents = await Promise.all(before.map(({ name }) => read(new URL(name, directory))));
			const after = await snapshot();
			if (
				before.length === after.length &&
				before.every((file, index) => {
					const next = after[index];
					return next && file.name === next.name && file.dev === next.dev && file.ino === next.ino;
				})
			)
				return contents.join('\n');
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
	}
	throw new Error('Server log rotation prevented a consistent read after three attempts');
};
