// Read both current JSON records and historical prefix + JSON log files.
export const parseServerEvent = (line: string, markers: readonly string[]): object | undefined => {
	let message = line;
	try {
		const record: unknown = JSON.parse(line);
		if (typeof record !== 'object' || record === null) return undefined;
		const recordMessage: unknown = Reflect.get(record, 'message');
		if (typeof recordMessage !== 'string') return undefined;
		if (markers.includes(recordMessage)) return record;
		message = recordMessage;
	} catch {
		// Historical lines have a plain logger prefix. Partial JSON lines are
		// rejected by the payload parser below rather than treated as complete.
	}
	const marker = markers.find((value) => message.includes(`${value} `));
	if (!marker) return undefined;
	try {
		const payload: unknown = JSON.parse(message.slice(message.indexOf(marker) + marker.length + 1));
		return typeof payload === 'object' && payload !== null ? payload : undefined;
	} catch {
		return undefined;
	}
};
