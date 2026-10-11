import { readFile } from 'node:fs/promises';
import { parseServerEvent } from './parse-server-event';

const isolatedAppLog = new URL('../.runtime/data/logs/app.log', import.meta.url);

const readVoiceServerEvents = async () => {
	const contents = await readFile(isolatedAppLog, 'utf8');
	return contents.split('\n').flatMap((line, lineIndex) => {
		const payload = parseServerEvent(line, ['[voice-reconnect]', '[voice-session]']);
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
				scope: stringField('scope'),
				clientInstanceId: stringField('clientInstanceId'),
				userId: numberField('userId'),
				graceAgeMs: numberField('graceAgeMs'),
				ttlRemainingMs: numberField('ttlRemainingMs'),
				reconnectAttemptId: stringField('reconnectAttemptId'),
				kind: stringField('kind'),
				path: stringField('path'),
				outcome: stringField('outcome'),
			},
		];
	});
};

export { readVoiceServerEvents };
