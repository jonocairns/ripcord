import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

type TFileOperations = {
	writeFile: (
		filePath: string,
		contents: string,
		options: { encoding: 'utf8'; flag: 'wx'; mode: number },
	) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
};

const replaceFileAtomically = async (targetPath: string, contents: string, operations: TFileOperations = fs) => {
	const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;

	try {
		await operations.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		await operations.rename(temporaryPath, targetPath);
	} catch (error) {
		await operations.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
};

export { replaceFileAtomically };
