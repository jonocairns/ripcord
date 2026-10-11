import { describe, expect, it } from 'bun:test';
import { serializeDiagnosticData } from '../desktop-diagnostics';

describe('desktop diagnostic serialization', () => {
	it('retains error details across the IPC boundary and bounds cyclic or oversized data', () => {
		const cyclic: Record<string, unknown> = { error: new Error('ICE restart timed out'), attempt: 2 };
		cyclic.self = cyclic;
		const serialized = JSON.stringify(serializeDiagnosticData(cyclic));
		expect(serialized).toContain('ICE restart timed out');
		expect(serialized).toContain('"attempt":2');
		expect(serialized).toContain('[truncated]');
		expect(serializeDiagnosticData('x'.repeat(4000))).toHaveLength(2048);
		expect(serializeDiagnosticData(Array.from({ length: 100 }, () => 1))).toHaveLength(20);
		const branching = Array.from({ length: 20 }, () =>
			Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 'x')),
		);
		const bounded = JSON.stringify(serializeDiagnosticData(branching));
		expect(bounded).toContain('[truncated]');
		expect(bounded.length).toBeLessThan(8000);
	});
});
