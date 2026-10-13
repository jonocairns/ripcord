import { parseServerEvent } from './parse-server-event';
import { readServerLog } from './server-log';

const readVoiceServerEvents = async () => {
	const contents = await readServerLog();
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
