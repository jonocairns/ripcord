import { readFile } from 'node:fs/promises';

const isolatedAppLog = new URL('../.runtime/data/logs/app.log', import.meta.url);

export const readStreamServerEvents = async () => {
	const contents = await readFile(isolatedAppLog, 'utf8');
	return contents.split('\n').flatMap((line, lineIndex) => {
		const marker = '[stream-event] ';
		if (!line.includes(marker)) return [];
		let payload: unknown;
		try {
			payload = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
		} catch {
			return [];
		} // A live read may end in a partial JSON record.
		if (typeof payload !== 'object' || payload === null) return [];
		const stringField = (key: string) => {
			const value: unknown = Reflect.get(payload, key);
			return typeof value === 'string' ? value : undefined;
		};
		const numberField = (key: string) => {
			const value: unknown = Reflect.get(payload, key);
			return typeof value === 'number' ? value : undefined;
		};
		return [
			{
				lineIndex,
				event: stringField('event'),
				source: stringField('source'),
				producerId: stringField('producerId'),
				consumerId: stringField('consumerId'),
				clientSessionId: stringField('clientSessionId'),
				reconnectAttemptId: stringField('reconnectAttemptId'),
				reporterUserId: numberField('reporterUserId'),
				remoteId: numberField('remoteId'),
				sequence: numberField('sequence'),
			},
		];
	});
};
