import { Toaster } from '@/components/ui/sonner';
import 'prosemirror-view/style/prosemirror.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReconnectLab } from './components/debug/reconnect-lab.tsx';
import { StoreDebug } from './components/debug/store-debug.tsx';
import { DebugInfo } from './components/debug-info/index.tsx';
import { DesktopTitlebar } from './components/desktop-titlebar';
import { DesktopQuitCoordinator } from './components/desktop-quit-coordinator';
import { DevicesProvider } from './components/devices-provider/index.tsx';
import { DialogsProvider } from './components/dialogs/index.tsx';
import { ErrorBoundary } from './components/error-boundary/index.tsx';
import { Routing } from './components/routing/index.tsx';
import { ServerScreensProvider } from './components/server-screens/index.tsx';
import { ThemeProvider } from './components/theme-provider/index.tsx';
import { reportError } from './helpers/browser-logger.ts';
import { LocalStorageKey, migrateStorage } from './helpers/storage.ts';
import './index.css';
import { initializeRuntimeServerConfig } from './runtime/server-config.ts';

const bootstrap = async () => {
	migrateStorage();

	try {
		await initializeRuntimeServerConfig();
	} catch (error) {
		reportError('Failed to initialize runtime server configuration', error);
	}

	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<ErrorBoundary>
				<ThemeProvider defaultTheme="dark" storageKey={LocalStorageKey.VITE_UI_THEME}>
					<DebugInfo />
					<Toaster />
					<StoreDebug />
					<ReconnectLab />
					<DesktopQuitCoordinator />
					<div className="flex h-full min-h-0 flex-1 flex-col">
						<DesktopTitlebar />
						<div className="flex h-full min-h-0 flex-1 flex-col">
							<DevicesProvider>
								<DialogsProvider />
								<ServerScreensProvider />
								<div className="flex h-full min-h-0 flex-1 flex-col">
									<Routing />
								</div>
							</DevicesProvider>
						</div>
					</div>
				</ThemeProvider>
			</ErrorBoundary>
		</StrictMode>,
	);
};

void bootstrap();
