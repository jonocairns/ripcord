import { useEffect, useState } from 'react';

const getIsWindowFocused = () => {
	if (typeof window === 'undefined') {
		return true;
	}

	return document.visibilityState === 'visible' && document.hasFocus();
};

export const useWindowFocus = () => {
	const [isWindowFocused, setIsWindowFocused] = useState(getIsWindowFocused);

	useEffect(() => {
		const updateWindowFocus = () => {
			setIsWindowFocused(getIsWindowFocused());
		};

		window.addEventListener('focus', updateWindowFocus);
		window.addEventListener('blur', updateWindowFocus);
		document.addEventListener('visibilitychange', updateWindowFocus);

		return () => {
			window.removeEventListener('focus', updateWindowFocus);
			window.removeEventListener('blur', updateWindowFocus);
			document.removeEventListener('visibilitychange', updateWindowFocus);
		};
	}, []);

	return isWindowFocused;
};
