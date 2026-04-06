import { Toaster } from '@/components/ui/sonner';
import 'prosemirror-view/style/prosemirror.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreDebug } from './components/debug/store-debug.tsx';
import { DebugInfo } from './components/debug-info/index.tsx';
import { DevicesProvider } from './components/devices-provider/index.tsx';
import { DialogsProvider } from './components/dialogs/index.tsx';
import { Routing } from './components/routing/index.tsx';
import { ServerScreensProvider } from './components/server-screens/index.tsx';
import { ThemeProvider } from './components/theme-provider/index.tsx';
import { initializeClientLogger, reportError } from './helpers/browser-logger.ts';
import { LocalStorageKey, migrateStorage } from './helpers/storage.ts';
import './index.css';
import { initializeRuntimeServerConfig } from './runtime/server-config.ts';

const bootstrap = async () => {
	migrateStorage();
	await initializeClientLogger();

	try {
		await initializeRuntimeServerConfig();
	} catch (error) {
		reportError('Failed to initialize runtime server configuration', error);
	}

	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<ThemeProvider defaultTheme="dark" storageKey={LocalStorageKey.VITE_UI_THEME}>
				<DebugInfo />
				<Toaster />
				<StoreDebug />
				<DevicesProvider>
					<DialogsProvider />
					<ServerScreensProvider />
					<Routing />
				</DevicesProvider>
			</ThemeProvider>
		</StrictMode>,
	);
};

void bootstrap();
