import { describe, expect, test } from 'bun:test';
import { deepMerge } from '../deep-merge';

describe('deepMerge', () => {
	test('merges flat objects', () => {
		const target = { a: 1, b: 2 };
		const source = { b: 3 };

		expect(deepMerge(target, source)).toEqual({ a: 1, b: 3 });
	});

	test('adds new keys from source', () => {
		const target = { a: 1 } as Record<string, unknown>;
		const source = { b: 2 };

		expect(deepMerge(target, source)).toEqual({
			a: 1,
			b: 2,
		});
	});

	test('deeply merges nested objects', () => {
		const target = {
			server: { port: 4991, debug: false },
			http: { maxFiles: 40 },
		};
		const source: Partial<typeof target> = {
			server: { port: 8080 },
		} as Partial<typeof target>;

		expect(deepMerge(target, source)).toEqual({
			server: { port: 8080, debug: false },
			http: { maxFiles: 40 },
		});
	});

	test('deeply merges multiple levels', () => {
		const target = {
			a: {
				b: {
					c: 1,
					d: 2,
				},
				e: 3,
			},
		};
		const source: Partial<typeof target> = {
			a: {
				b: {
					c: 99,
				},
			},
		} as Partial<typeof target>;

		expect(deepMerge(target, source)).toEqual({
			a: {
				b: {
					c: 99,
					d: 2,
				},
				e: 3,
			},
		});
	});

	test('overwrites primitives with source values', () => {
		const target = { a: 'hello', b: 42, c: true };
		const source = { a: 'world', c: false };

		expect(deepMerge(target, source)).toEqual({
			a: 'world',
			b: 42,
			c: false,
		});
	});

	test('does not mutate the target object', () => {
		const target = { a: 1, b: { c: 2 } };
		const source = { b: { c: 99 } };

		const result = deepMerge(target, source);

		expect(result).toEqual({ a: 1, b: { c: 99 } });
		expect(target).toEqual({ a: 1, b: { c: 2 } });
	});

	test('does not mutate the source object', () => {
		const target = { a: { b: 1, c: 2 } };
		const source = { a: { b: 99 } } as Partial<typeof target>;

		const originalSource = structuredClone(source);

		deepMerge(target, source);

		expect(source).toEqual(originalSource);
	});

	test('overwrites arrays instead of merging them', () => {
		const target = { items: [1, 2, 3] };
		const source = { items: [4, 5] };

		expect(deepMerge(target, source)).toEqual({ items: [4, 5] });
	});

	test('handles source overwriting object with primitive', () => {
		const target = { a: { nested: true } } as Record<string, unknown>;
		const source = { a: 'flat' };

		expect(deepMerge(target, source)).toEqual({ a: 'flat' });
	});

	test('skips undefined values in source', () => {
		const target = { a: 1, b: 2 };
		const source = { a: undefined };

		expect(deepMerge(target, source)).toEqual({ a: 1, b: 2 });
	});

	test('returns a copy when source is empty', () => {
		const target = { a: 1, b: { c: 2 } };
		const source = {};

		const result = deepMerge(target, source);

		expect(result).toEqual(target);
		expect(result).not.toBe(target);
	});

	test('ignores __proto__ keys', () => {
		const target = { a: 1 } as Record<string, unknown>;
		const source = JSON.parse('{"__proto__": {"polluted": true}}');

		const result = deepMerge(target, source);

		expect(result).toEqual({ a: 1 });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test('ignores constructor and prototype keys', () => {
		const target = { a: 1 } as Record<string, unknown>;
		const source = JSON.parse('{"constructor": {"polluted": true}, "prototype": {"bad": true}}');

		const result = deepMerge(target, source);

		expect(result).toEqual({ a: 1 });
	});

	test('works with the config.ini merge use case', () => {
		const defaultConfig = {
			server: { port: 4991, debug: false, autoupdate: false },
			http: { maxFiles: 40, maxFileSize: 100 },
			webRtc: {
				port: 40000,
				preferredFamily: 'ipv4' as const,
				ipv4: {
					enabled: true,
					bindAddress: '0.0.0.0',
					announcedAddress: '',
				},
				ipv6: {
					enabled: false,
					bindAddress: '::',
					announcedAddress: '',
				},
			},
		};

		const existingConfig: Partial<typeof defaultConfig> = {
			server: { port: 5000, debug: true },
			webRtc: {
				port: 50000,
				ipv6: {
					enabled: true,
				},
			} as Partial<(typeof defaultConfig)['webRtc']>,
		} as Partial<typeof defaultConfig>;

		const result = deepMerge(defaultConfig, existingConfig);

		expect(result).toEqual({
			server: { port: 5000, debug: true, autoupdate: false },
			http: { maxFiles: 40, maxFileSize: 100 },
			webRtc: {
				port: 50000,
				preferredFamily: 'ipv4',
				ipv4: {
					enabled: true,
					bindAddress: '0.0.0.0',
					announcedAddress: '',
				},
				ipv6: {
					enabled: true,
					bindAddress: '::',
					announcedAddress: '',
				},
			},
		});
	});
});
