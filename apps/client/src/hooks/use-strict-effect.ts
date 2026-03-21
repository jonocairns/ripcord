import type { DependencyList, EffectCallback } from 'react';
import { useEffect, useRef } from 'react';

const useStrictEffect = (effect: EffectCallback, deps?: DependencyList) => {
	const ran = useRef(false);

	useEffect(() => {
		if (ran.current) return;

		const cleanup = effect();

		ran.current = true;

		return cleanup;
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps passed dynamically by caller
	}, deps);
};

export { useStrictEffect };
