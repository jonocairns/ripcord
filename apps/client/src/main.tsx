import * as Sentry from '@sentry/react';
import { Toaster } from '@/components/ui/sonner';
import 'prosemirror-view/style/prosemirror.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReconnectLab } from './components/debug/reconnect-lab.tsx';
import { StoreDebug } from './components/debug/store-debug.tsx';
import { DebugInfo } from './components/debug-info/index.tsx';
import { DesktopQuitCoordinator } from './components/desktop-quit-coordinator';
import { DesktopTitlebar } from './components/desktop-titlebar';
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

// Dark-only is a release policy, not a component-level styling requirement.
// Remove this forced theme when the light palette is ready to ship.
const SHIPPED_THEME = 'dark';

const bootstrap = async () => {
	migrateStorage();

	try {
		await initializeRuntimeServerConfig();
	} catch (error) {
		reportError('Failed to initialize runtime server configuration', error);
	}

	// React 19 routes render-phase errors to these root hooks instead of
	// window.onerror, so without them they never reach Sentry. onUncaughtError
	// covers errors that escape every boundary (incl. one thrown in a boundary's
	// own fallback); onRecoverableError covers errors React auto-recovered from
	// (e.g. hydration mismatches) that no boundary ever sees. onCaughtError is
	// intentionally omitted — the <ErrorBoundary> below already reports caught
	// errors with richer scope tags, and adding it here would double-report.
	createRoot(document.getElementById('root')!, {
		onUncaughtError: Sentry.reactErrorHandler(),
		onRecoverableError: Sentry.reactErrorHandler(),
	}).render(
		<StrictMode>
			<ErrorBoundary>
				<ThemeProvider defaultTheme="dark" forcedTheme={SHIPPED_THEME} storageKey={LocalStorageKey.VITE_UI_THEME}>
					<DebugInfo />
					<Toaster />
					<StoreDebug />
					<ReconnectLab />
					<DesktopQuitCoordinator />
					<div className="flex h-full min-h-0 flex-1 flex-col">
						<DesktopTitlebar />
						<div id="screen-content">
							<DevicesProvider>
								<DialogsProvider />
								<ServerScreensProvider />
								<Routing />
							</DevicesProvider>
							<div id="portal" />
						</div>
					</div>
				</ThemeProvider>
			</ErrorBoundary>
		</StrictMode>,
	);
};

void bootstrap();
