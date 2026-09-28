import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type TFileOperations = {
	writeFile: (
		filePath: string,
		contents: string,
		options: { encoding: 'utf8'; flag: 'wx'; mode: number },
	) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
};

const replaceFileAtomically = async (
	targetPath: string,
	contents: string,
	operations: TFileOperations = fs,
	replace?: (temporaryPath: string, targetPath: string) => Promise<boolean>,
) => {
	const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
	let replaced = false;

	try {
		await operations.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		if (replace) {
			replaced = await replace(temporaryPath, targetPath);
		} else {
			await operations.rename(temporaryPath, targetPath);
			replaced = true;
		}
	} finally {
		if (!replaced) {
			await operations.unlink(temporaryPath).catch(() => undefined);
		}
	}
};

// Temporary writes may overlap. Replacements run in order, and a request that
// finishes writing after a newer request has started does not replace it.
const createLatestAtomicFileWriter = (operations: TFileOperations = fs) => {
	let latestRequestId = 0;
	let pendingReplacement: Promise<void> = Promise.resolve();

	return async (targetPath: string, contents: string) => {
		const requestId = ++latestRequestId;

		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await replaceFileAtomically(targetPath, contents, operations, (temporaryPath, destinationPath) => {
			const replacement = pendingReplacement.then(async () => {
				if (requestId !== latestRequestId) {
					return false;
				}

				await operations.rename(temporaryPath, destinationPath);
				return true;
			});
			pendingReplacement = replacement.then(
				() => undefined,
				() => undefined,
			);
			return replacement;
		});
	};
};

export { createLatestAtomicFileWriter, replaceFileAtomically };
