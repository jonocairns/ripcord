import { readFile } from 'node:fs/promises';
import { parseServerEvent } from './parse-server-event';

const isolatedAppLog = new URL('../.runtime/data/logs/app.log', import.meta.url);

export const readStreamServerEvents = async () => {
	const contents = await readFile(isolatedAppLog, 'utf8');
	return contents.split('\n').flatMap((line, lineIndex) => {
		const payload = parseServerEvent(line, ['[stream-event]']);
		if (!payload) return [];
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
