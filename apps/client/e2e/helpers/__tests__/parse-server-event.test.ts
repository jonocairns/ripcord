import { expect, test } from 'bun:test';
import { parseServerEvent } from '../parse-server-event';

test('reads structured and historical stream/voice correlation without losing client time', () => {
	const event = {
		source: 'client',
		event: 'consume_succeeded',
		occurredAt: 100,
		receivedAt: 200,
		clientSessionId: 'client',
		reconnectAttemptId: 'restore',
		producerId: 'producer',
	};
	for (const marker of ['[stream-event]', '[voice-session]', '[voice-reconnect]']) {
		expect(parseServerEvent(JSON.stringify({ message: marker, level: 'info', ...event }), [marker])).toMatchObject(
			event,
		);
		expect(parseServerEvent(`info: ${marker} ${JSON.stringify(event)}`, [marker])).toEqual(event);
		expect(
			parseServerEvent(JSON.stringify({ message: `${marker} ${JSON.stringify(event)}`, level: 'info' }), [marker]),
		).toEqual(event);
	}
});

test('ignores unrelated and partial lines during live reads', () => {
	for (const line of [
		'{"message":"[stream-event]",',
		'info: [stream-event] {"event":',
		JSON.stringify({ message: 'Ordinary log', producerId: 'producer' }),
		'[]',
		'null',
	])
		expect(parseServerEvent(line, ['[stream-event]'])).toBeUndefined();
});
