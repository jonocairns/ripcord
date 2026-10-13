// `ini` parses sections into null-prototype objects, which fail `instanceof Object`.
const isMergeableObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const deepMerge = <T extends Record<string, unknown>>(target: T, source: Partial<T>): T => {
	const result = { ...target };

	for (const key in source) {
		if (!Object.hasOwn(source, key)) continue;
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

		const sourceValue = source[key];
		const targetValue = target[key];

		if (isMergeableObject(sourceValue) && isMergeableObject(targetValue)) {
			result[key] = deepMerge<Record<string, unknown>>(targetValue, sourceValue) as T[Extract<keyof T, string>];
		} else if (sourceValue !== undefined) {
			result[key] = sourceValue as T[Extract<keyof T, string>];
		}
	}

	return result;
};

export { deepMerge };
