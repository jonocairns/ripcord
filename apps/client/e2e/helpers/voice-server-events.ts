import { readFile } from 'node:fs/promises';

const isolatedAppLog = new URL('../.runtime/data/logs/app.log', import.meta.url);

const readVoiceServerEvents = async () => {
	const contents = await readFile(isolatedAppLog, 'utf8');
	return contents.split('\n').flatMap((line, lineIndex) => {
		const marker = ['[voice-reconnect] ', '[voice-session] '].find((prefix) => line.includes(prefix));
		if (!marker) return [];
		let payload: unknown;
		try {
			payload = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
		} catch {
			// A live log read can end partway through the latest JSON line.
			return [];
		}
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
