import { type MutableRefObject, useEffect, useRef } from 'react';

// Mirrors the latest value of a reactive dependency into a stable ref so callbacks
// and async flows can read it without taking it as a dependency. Updates after commit,
// matching a hand-written `useEffect(() => { ref.current = value }, [value])`.
const useLatestRef = <T>(value: T): MutableRefObject<T> => {
	const ref = useRef(value);
	useEffect(() => {
		ref.current = value;
	}, [value]);
	return ref;
};

export { useLatestRef };
