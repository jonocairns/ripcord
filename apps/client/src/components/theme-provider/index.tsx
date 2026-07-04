import { createContext, useEffect, useState } from 'react';
import { getLocalStorageItem, LocalStorageKey, setLocalStorageItem } from '@/helpers/storage';

type Theme = 'dark' | 'light' | 'system';
type ResolvedTheme = Exclude<Theme, 'system'>;

type ThemeProviderProps = {
	children: React.ReactNode;
	defaultTheme?: Theme;
	forcedTheme?: ResolvedTheme;
	storageKey?: LocalStorageKey;
};

type ThemeProviderState = {
	theme: Theme;
	setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
	theme: 'system',
	setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

const isTheme = (value: string | null): value is Theme => {
	return value === 'dark' || value === 'light' || value === 'system';
};

const getSystemTheme = (): ResolvedTheme => {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const getResolvedTheme = (theme: Theme): ResolvedTheme => {
	return theme === 'system' ? getSystemTheme() : theme;
};

function ThemeProvider({
	children,
	defaultTheme = 'system',
	forcedTheme,
	storageKey = LocalStorageKey.VITE_UI_THEME,
	...props
}: ThemeProviderProps) {
	const [theme, setTheme] = useState<Theme>(() => {
		const storedTheme = getLocalStorageItem(storageKey);
		return isTheme(storedTheme) ? storedTheme : defaultTheme;
	});

	useEffect(() => {
		const root = window.document.documentElement;
		const resolvedTheme = forcedTheme ?? getResolvedTheme(theme);

		root.classList.remove('light', 'dark');
		root.classList.add(resolvedTheme);
		root.style.colorScheme = resolvedTheme;
	}, [forcedTheme, theme]);

	const value = {
		theme: forcedTheme ?? theme,
		setTheme: (nextTheme: Theme) => {
			setLocalStorageItem(storageKey, nextTheme);
			setTheme(nextTheme);
		},
	};

	return (
		<ThemeProviderContext.Provider {...props} value={value}>
			{children}
		</ThemeProviderContext.Provider>
	);
}

export { ThemeProvider };
