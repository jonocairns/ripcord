import fs from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/electron/main';
import {
	app,
	BrowserWindow,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	MessageChannelMain,
	type MessagePortMain,
	powerMonitor,
	session,
	shell,
} from 'electron';
import { AppAudioRtpSender, type TAppAudioRtpTarget } from './app-audio-rtp-sender';
import { resolveDesktopCaptureCapabilities } from './capture-capabilities';
import { captureSidecarManager } from './capture-sidecar-manager';
import { configureMainErrorReporting } from './error-reporting';
import {
	validateConfigureErrorReportingArgs,
	validateDesktopQuitFlushResultArgs,
	validateListAppAudioTargetsArgs,
	validatePrepareScreenShareArgs,
	validateSetGlobalPushKeybindsArgs,
	validateSetServerUrlArgs,
	validateStartAppAudioCaptureArgs,
	validateStartAppAudioRtpArgs,
	validateStopAppAudioCaptureArgs,
} from './ipc-validators';
import { classifyMainFrameNavigationUrl } from './navigation-policy';
import { isPermissionAllowed } from './permission-policy';
import { getDesktopCapabilities, resolvePreparedScreenAudioMode } from './platform-capabilities';
import { previewRuntimeConfig } from './preview-runtime-config';
import { installDevRendererCspHandler, installPackagedRendererCspHandler } from './renderer-csp';
import { isTrustedRendererUrl, resolveTrustedRendererUrl, type TRendererTrustOptions } from './renderer-trust';
import {
	clearPreparedScreenShareSelection,
	consumeScreenShareSelection,
	getSourceById,
	listShareSources,
	prepareScreenShareSelection,
} from './screen-share';
import { getServerUrl, setServerUrl } from './settings-store';
import type {
	TAppAudioPcmFrame,
	TDesktopCapabilities,
	TDesktopProcessCrashEvent,
	TDesktopPushKeybindEvent,
	TDesktopPushKeybindsInput,
	TDesktopQuitFlushResult,
	TDesktopWindowControlsState,
	TGlobalPushKeybindRegistrationResult,
	TScreenShareSelection,
	TStartAppAudioCaptureInput,
} from './types';
import { desktopUpdater } from './updater';
import { classifyWindowOpenUrl } from './window-open-policy';
import { installYoutubeEmbedRefererHandler } from './youtube-embed-referrer';

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const TRUSTED_RENDERER_URL = resolveTrustedRendererUrl({
	isPackaged: app.isPackaged,
	isPreview: previewRuntimeConfig !== null,
	rendererUrl: RENDERER_URL,
});
const DESKTOP_QUIT_FLUSH_TIMEOUT_MS = 2_000;
const DESKTOP_DEBUG_IPC_ENABLED = Boolean(TRUSTED_RENDERER_URL);
const USES_CUSTOM_TITLEBAR = process.platform === 'win32' || process.platform === 'linux';
let mainWindow: BrowserWindow | null = null;
let appAudioFrameEgressPort: MessagePortMain | undefined;
// When set, native RTP ingest owns the sidecar PCM egress: PCM is encoded and
// sent here in main and is NOT forwarded to the renderer worklet. The two are
// mutually exclusive consumers of the single binary egress (single-active sink).
let appAudioRtpSender: AppAudioRtpSender | undefined;
let lastDesktopCapabilitiesSnapshot: string | undefined;
let refreshDesktopCapabilitiesPromise: Promise<TDesktopCapabilities> | undefined;
let refreshDesktopCapabilitiesBroadcastPending = false;
let refreshDesktopCapabilitiesForceBroadcastPending = false;
let displayMediaUsesSystemPicker = false;
let appIsShuttingDown = false;
let desktopQuitFlushInterceptInProgress = false;
let desktopQuitFlushCompleted = false;
let resolveDesktopQuitFlush: ((result: TDesktopQuitFlushResult) => void) | undefined;

const sendToRenderer = (channel: string, ...args: unknown[]): boolean => {
	if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
		return false;
	}

	try {
		mainWindow.webContents.send(channel, ...args);
		return true;
	} catch {
		return false;
	}
};

// Terminal-only crash diagnostics for local debugging (e.g. running the packaged
// exe with --enable-logging). Sentry reporting of these crashes is handled by the
// main-process SDK (error-reporting.ts): its childProcessIntegration captures
// child-process (GPU) crashes and it captures render-process-gone + native
// minidumps. We keep these handlers purely so a crash is visible in stdout even
// when no DSN is configured.
const reportProcessCrash = (event: TDesktopProcessCrashEvent): void => {
	console.error('[desktop] Process crashed', event);
};

app.on('child-process-gone', (_event, details) => {
	reportProcessCrash({
		source: 'child-process',
		processType: details.type,
		reason: details.reason,
		exitCode: details.exitCode,
		serviceName: details.serviceName,
		name: details.name,
	});
});

const disposeAppAudioFrameEgressPort = (port: MessagePortMain | undefined = appAudioFrameEgressPort): void => {
	if (!port) {
		return;
	}

	if (appAudioFrameEgressPort === port) {
		appAudioFrameEgressPort = undefined;
	}

	try {
		port.close();
	} catch {
		// ignore
	}

	port.removeAllListeners();
};

const stopAppAudioRtpSender = (): void => {
	const sender = appAudioRtpSender;

	if (!sender) {
		return;
	}

	appAudioRtpSender = undefined;

	try {
		sender.stop();
	} catch (error) {
		console.warn('[desktop] Failed to stop app-audio RTP sender', error);
	}
};

if (process.platform === 'win32') {
	app.setAppUserModelId(previewRuntimeConfig?.appUserModelId || 'com.sharkord.desktop');
}

const resolveAppIconPath = (): string | undefined => {
	const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
	const iconPath = path.join(__dirname, '..', '..', 'assets', 'icons', iconFile);

	if (!fs.existsSync(iconPath)) {
		return undefined;
	}

	return iconPath;
};

const emitPushKeybindEvent = (event: TDesktopPushKeybindEvent) => {
	sendToRenderer('desktop:global-push-keybind', event);
};

const resolveDesktopPlatform = (): TDesktopWindowControlsState['platform'] => {
	if (process.platform === 'darwin') {
		return 'macos';
	}

	if (process.platform === 'win32') {
		return 'windows';
	}

	return 'linux';
};

const getWindowControlsState = (): TDesktopWindowControlsState => {
	return {
		platform: resolveDesktopPlatform(),
		isMaximized: mainWindow?.isMaximized() ?? false,
		usesCustomTitlebar: USES_CUSTOM_TITLEBAR,
	};
};

const emitWindowControlsState = () => {
	sendToRenderer('desktop:window-controls-state-changed', getWindowControlsState());
};

const disposeDesktopServicesForShutdown = () => {
	stopAppAudioRtpSender();
	disposeAppAudioFrameEgressPort();
	desktopUpdater.dispose();
	void captureSidecarManager.dispose();
};

const completeDesktopQuitFlush = (result: TDesktopQuitFlushResult) => {
	if (!resolveDesktopQuitFlush) {
		return;
	}

	const resolve = resolveDesktopQuitFlush;
	resolveDesktopQuitFlush = undefined;
	resolve(result);
};

const requestDesktopQuitFlush = async (): Promise<TDesktopQuitFlushResult> => {
	if (!sendToRenderer('desktop:before-quit')) {
		return {
			status: 'skipped',
			reason: 'renderer-unavailable',
		};
	}

	return await new Promise<TDesktopQuitFlushResult>((resolve) => {
		const timeout = setTimeout(() => {
			resolveDesktopQuitFlush = undefined;
			resolve({
				status: 'skipped',
				reason: 'timeout',
			});
		}, DESKTOP_QUIT_FLUSH_TIMEOUT_MS);

		resolveDesktopQuitFlush = (result) => {
			clearTimeout(timeout);
			resolve(result);
		};
	});
};

const setGlobalPushKeybinds = async (
	input?: TDesktopPushKeybindsInput,
): Promise<TGlobalPushKeybindRegistrationResult> => {
	return await captureSidecarManager.setPushKeybinds(input || {});
};

const resolveSidecarStatusFromCapabilities = (
	sidecarCapabilities: Awaited<ReturnType<typeof captureSidecarManager.getCapabilities>>,
) => {
	if (
		sidecarCapabilities.platform === 'macos' &&
		(sidecarCapabilities.systemAudio !== 'supported' || sidecarCapabilities.perAppAudio !== 'supported')
	) {
		return {
			available: false,
			reason: sidecarCapabilities.reason || 'macOS screen audio capture is unavailable.',
		};
	}

	return {
		available: true,
		reason: sidecarCapabilities.reason,
	};
};

const getEffectiveDesktopCapabilities = async () => {
	const baseCapabilities = getDesktopCapabilities();
	const sidecarCapabilities = await captureSidecarManager.getCapabilities().catch(() => undefined);
	const sidecarStatus = sidecarCapabilities
		? resolveSidecarStatusFromCapabilities(sidecarCapabilities)
		: await captureSidecarManager.getStatus();
	const sidecarPerAppAudioSupported = sidecarCapabilities
		? sidecarCapabilities.perAppAudio !== 'unsupported'
		: baseCapabilities.platform === 'windows' && sidecarStatus.available;
	const sidecarReason = sidecarCapabilities?.perAppAudioReason ?? sidecarStatus.reason;

	return resolveDesktopCaptureCapabilities({
		baseCapabilities,
		sidecarAvailable: sidecarStatus.available,
		sidecarReason,
		sidecarPerAppAudioSupported,
		sidecarCapabilities,
	});
};

const refreshDesktopCapabilities = async (options: { broadcast?: boolean; forceBroadcast?: boolean } = {}) => {
	refreshDesktopCapabilitiesBroadcastPending = refreshDesktopCapabilitiesBroadcastPending || options.broadcast === true;
	refreshDesktopCapabilitiesForceBroadcastPending =
		refreshDesktopCapabilitiesForceBroadcastPending || options.forceBroadcast === true;

	if (refreshDesktopCapabilitiesPromise) {
		return await refreshDesktopCapabilitiesPromise;
	}

	refreshDesktopCapabilitiesPromise = (async () => {
		while (true) {
			const capabilities = await getEffectiveDesktopCapabilities();
			const snapshot = JSON.stringify(capabilities);
			const didChange = snapshot !== lastDesktopCapabilitiesSnapshot;
			lastDesktopCapabilitiesSnapshot = snapshot;

			const shouldBroadcast = refreshDesktopCapabilitiesBroadcastPending;
			const shouldForceBroadcast = refreshDesktopCapabilitiesForceBroadcastPending;
			refreshDesktopCapabilitiesBroadcastPending = false;
			refreshDesktopCapabilitiesForceBroadcastPending = false;

			if (shouldBroadcast && (shouldForceBroadcast || didChange)) {
				sendToRenderer('desktop:capabilities-changed', capabilities);
			}

			if (!refreshDesktopCapabilitiesBroadcastPending && !refreshDesktopCapabilitiesForceBroadcastPending) {
				return capabilities;
			}
		}
	})().finally(() => {
		refreshDesktopCapabilitiesPromise = undefined;
	});

	return await refreshDesktopCapabilitiesPromise;
};

const requestDesktopCapabilitiesRefresh = (options: { broadcast?: boolean; forceBroadcast?: boolean } = {}) => {
	if (appIsShuttingDown) {
		return;
	}

	void refreshDesktopCapabilities(options).catch((error) => {
		console.warn('[desktop] Failed to refresh desktop capabilities', error);
	});
};

const resolveRendererIndexPath = (): string => {
	return path.join(__dirname, '..', '..', 'renderer-dist', 'index.html');
};

const rendererTrustOptions: TRendererTrustOptions = {
	packagedIndexPath: resolveRendererIndexPath(),
	rendererUrl: TRUSTED_RENDERER_URL,
};

const isTrustedIpcSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
	const senderUrl = event.senderFrame?.url;

	if (senderUrl && isTrustedRendererUrl(senderUrl, rendererTrustOptions)) {
		return true;
	}

	console.warn('[desktop] Rejected IPC message from untrusted sender', {
		senderUrl,
	});

	return false;
};

const assertTrustedIpcSender = (event: IpcMainInvokeEvent): void => {
	if (!isTrustedIpcSender(event)) {
		throw new Error('Rejected IPC message from an untrusted sender frame');
	}
};

const handleTrusted = <TArgs extends unknown[], TResult>(
	channel: string,
	listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult,
	validateArgs?: (args: unknown[]) => TArgs,
): void => {
	ipcMain.handle(channel, (event, ...args) => {
		assertTrustedIpcSender(event);
		const validatedArgs = validateArgs ? validateArgs(args) : (args as TArgs);
		return listener(event, ...validatedArgs);
	});
};

const onTrusted = <TArgs extends unknown[]>(
	channel: string,
	listener: (event: IpcMainEvent, ...args: TArgs) => void,
	validateArgs?: (args: unknown[]) => TArgs,
): void => {
	ipcMain.on(channel, (event, ...args) => {
		if (!isTrustedIpcSender(event)) {
			return;
		}

		try {
			const validatedArgs = validateArgs ? validateArgs(args) : (args as TArgs);
			listener(event, ...validatedArgs);
		} catch (error) {
			console.warn('[desktop] Rejected IPC message with invalid payload', {
				channel,
				error,
			});
		}
	});
};

const createMainWindow = () => {
	const icon = resolveAppIconPath();
	const indexPath = resolveRendererIndexPath();
	let windowCloseFlushCompleted = false;
	let rendererUnresponsiveSince: number | undefined;

	mainWindow = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 1120,
		minHeight: 720,
		frame: !USES_CUSTOM_TITLEBAR,
		autoHideMenuBar: true,
		show: false,
		backgroundColor: '#090d12',
		icon,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
			// Chromium throttles (and can freeze) the renderer when the window is
			// hidden, minimized, or occluded by another fullscreen window. For a
			// real-time voice/screen-share client that freezes the whole renderer
			// process — stopping the WS keepalive and WebRTC media — so the server
			// tears the voice session down (1006 + media-liveness) even though
			// nothing crashed. Keep the renderer running at full speed always.
			backgroundThrottling: false,
		},
	});
	mainWindow.setMenuBarVisibility(false);

	mainWindow.once('ready-to-show', () => {
		mainWindow?.show();
	});
	mainWindow.on('maximize', () => {
		emitWindowControlsState();
	});
	mainWindow.on('unmaximize', () => {
		emitWindowControlsState();
	});
	mainWindow.on('focus', () => {
		requestDesktopCapabilitiesRefresh({
			broadcast: true,
		});
	});
	mainWindow.on('close', (event) => {
		const windowToClose = mainWindow;

		if (desktopQuitFlushCompleted || windowCloseFlushCompleted) {
			return;
		}

		event.preventDefault();

		if (desktopQuitFlushInterceptInProgress) {
			return;
		}

		desktopQuitFlushInterceptInProgress = true;

		void (async () => {
			const result = await requestDesktopQuitFlush();

			if (result.status === 'skipped') {
				console.warn('[desktop] Window close flush skipped', {
					reason: result.reason,
				});
			}

			desktopQuitFlushInterceptInProgress = false;

			if (process.platform !== 'darwin' || appIsShuttingDown) {
				appIsShuttingDown = true;
				desktopQuitFlushCompleted = true;
				app.quit();
				return;
			}

			windowCloseFlushCompleted = true;
			if (windowToClose && !windowToClose.isDestroyed()) {
				windowToClose.close();
			}
		})();
	});
	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		reportProcessCrash({
			source: 'renderer',
			processType: 'renderer',
			reason: details.reason,
			exitCode: details.exitCode,
		});
	});

	// A renderer can hang without crashing (so render-process-gone never fires):
	// a frozen renderer stops pumping the WS keepalive and WebRTC media, so the
	// server tears the voice session down (1006 + media-liveness) with no crash
	// and no telemetry. Surface these explicitly so the hang — and its duration —
	// is visible instead of silent.
	mainWindow.webContents.on('unresponsive', () => {
		rendererUnresponsiveSince = Date.now();
		console.error('[desktop] Renderer unresponsive');
		Sentry.captureMessage('Renderer unresponsive', {
			level: 'warning',
			tags: { component: 'renderer', event: 'unresponsive' },
		});
	});

	mainWindow.webContents.on('responsive', () => {
		const unresponsiveDurationMs =
			rendererUnresponsiveSince === undefined ? undefined : Date.now() - rendererUnresponsiveSince;
		rendererUnresponsiveSince = undefined;
		console.info('[desktop] Renderer responsive again', { unresponsiveDurationMs });
		Sentry.captureMessage('Renderer responsive again', {
			level: 'info',
			tags: { component: 'renderer', event: 'responsive' },
			...(unresponsiveDurationMs === undefined ? {} : { extra: { unresponsiveDurationMs } }),
		});
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		const policy = classifyWindowOpenUrl(url);

		if (policy.action === 'allow') {
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					icon,
					autoHideMenuBar: true,
					backgroundColor: '#000000',
					resizable: true,
				},
			};
		}

		if (policy.openExternal) {
			void shell.openExternal(url);
		}

		return { action: 'deny' };
	});

	mainWindow.webContents.on('will-frame-navigate', (event) => {
		if (!event.isMainFrame) {
			return;
		}

		const policy = classifyMainFrameNavigationUrl(event.url, {
			packagedIndexPath: indexPath,
			rendererUrl: TRUSTED_RENDERER_URL,
		});

		if (policy.action === 'allow') {
			return;
		}

		event.preventDefault();

		if (policy.openExternal) {
			void shell.openExternal(event.url);
		}
	});

	mainWindow.webContents.on('did-create-window', (childWindow, details) => {
		if (!details.url.startsWith('about:blank')) {
			return;
		}

		childWindow.setAutoHideMenuBar(true);
		childWindow.setMenuBarVisibility(false);
	});

	if (TRUSTED_RENDERER_URL) {
		void mainWindow.loadURL(TRUSTED_RENDERER_URL);
		return;
	}

	void mainWindow.loadFile(indexPath);
};

const setupDisplayMediaHandler = (useSystemPicker = displayMediaUsesSystemPicker) => {
	displayMediaUsesSystemPicker = useSystemPicker;

	session.defaultSession.setDisplayMediaRequestHandler(
		(_request, callback) => {
			void (async () => {
				const rejectRequest = () => {
					callback({
						video: undefined,
						audio: undefined,
					});
				};

				try {
					const pendingSelection = consumeScreenShareSelection();

					if (!pendingSelection) {
						rejectRequest();
						return;
					}

					const source = await getSourceById(pendingSelection.sourceId);

					if (!source) {
						rejectRequest();
						return;
					}

					// Always provide loopback audio for system mode so that
					// getDisplayMedia can serve as a fallback when the sidecar is
					// unavailable or fails.  The client discards this track when the
					// sidecar successfully handles audio capture.
					const shouldShareAudio = pendingSelection.audioMode === 'system';

					callback({
						video: source,
						audio: shouldShareAudio ? 'loopback' : undefined,
					});
				} catch (error) {
					console.error('[desktop] Failed to handle display media request', error);
					rejectRequest();
				}
			})();
		},
		{
			useSystemPicker,
		},
	);
};

const setDisplayMediaUseSystemPicker = (useSystemPicker: boolean) => {
	if (displayMediaUsesSystemPicker === useSystemPicker) {
		return;
	}

	setupDisplayMediaHandler(useSystemPicker);
};

const isTrustedPermissionRequester = (requestingUrl: string | undefined | null): boolean => {
	if (!requestingUrl) {
		return false;
	}

	return isTrustedRendererUrl(requestingUrl, rendererTrustOptions);
};

const setupPermissionHandlers = () => {
	session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		const requestingUrl = details?.requestingUrl ?? webContents?.getURL();
		const allowed = isPermissionAllowed(permission, {
			isTrustedRequester: isTrustedPermissionRequester(requestingUrl),
		});

		if (!allowed) {
			console.warn('[desktop] Denied permission request', {
				permission,
				requestingUrl,
			});
		}

		callback(allowed);
	});

	session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
		return isPermissionAllowed(permission, {
			isTrustedRequester: isTrustedPermissionRequester(details?.requestingUrl ?? requestingOrigin),
		});
	});
};

const setupYoutubeEmbedRefererHandler = () => {
	installYoutubeEmbedRefererHandler(session.defaultSession);
};

const setupRendererCspHandler = () => {
	if (TRUSTED_RENDERER_URL) {
		installDevRendererCspHandler(session.defaultSession, TRUSTED_RENDERER_URL);
		return;
	}

	const rendererDistPath = path.join(__dirname, '..', '..', 'renderer-dist');
	installPackagedRendererCspHandler(session.defaultSession, rendererDistPath);
};

const registerIpcHandlers = () => {
	handleTrusted('desktop:get-server-url', () => {
		return getServerUrl();
	});

	handleTrusted(
		'desktop:configure-error-reporting',
		(_event, config) => {
			configureMainErrorReporting(config);
		},
		validateConfigureErrorReportingArgs,
	);

	handleTrusted('desktop:get-window-controls-state', () => {
		return getWindowControlsState();
	});

	handleTrusted('desktop:minimize-window', (event: IpcMainInvokeEvent): void => {
		const window = BrowserWindow.fromWebContents(event.sender);
		window?.minimize();
	});

	handleTrusted('desktop:toggle-maximize-window', (event: IpcMainInvokeEvent): void => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) return;
		if (window.isMaximized()) {
			window.unmaximize();
		} else {
			window.maximize();
		}
	});

	handleTrusted('desktop:close-window', (event: IpcMainInvokeEvent): void => {
		const window = BrowserWindow.fromWebContents(event.sender);
		window?.close();
	});

	handleTrusted(
		'desktop:set-server-url',
		(_event: IpcMainInvokeEvent, serverUrl: string) => {
			return setServerUrl(serverUrl);
		},
		validateSetServerUrlArgs,
	);

	handleTrusted('desktop:get-capabilities', () => {
		return refreshDesktopCapabilities();
	});

	handleTrusted('desktop:get-system-idle-seconds', () => {
		return powerMonitor.getSystemIdleTime();
	});

	handleTrusted(
		'desktop:list-app-audio-targets',
		(_event, sourceId?: string) => {
			return captureSidecarManager.listAppAudioTargets(sourceId);
		},
		validateListAppAudioTargetsArgs,
	);

	handleTrusted(
		'desktop:start-app-audio-capture',
		(_event, input: TStartAppAudioCaptureInput) => {
			return captureSidecarManager.startAppAudioCapture({
				...input,
				selfExcludePid: process.pid,
			});
		},
		validateStartAppAudioCaptureArgs,
	);

	handleTrusted(
		'desktop:stop-app-audio-capture',
		(_event, sessionId?: string) => {
			return captureSidecarManager.stopAppAudioCapture(sessionId);
		},
		validateStopAppAudioCaptureArgs,
	);

	handleTrusted(
		'desktop:start-app-audio-rtp',
		async (_event, target: TAppAudioRtpTarget) => {
			// Starting native ingest takes ownership of the egress: tear down any
			// renderer worklet forwarding and any prior sender first so the two never
			// run against the single binary egress at once.
			disposeAppAudioFrameEgressPort();
			stopAppAudioRtpSender();

			const sender = new AppAudioRtpSender(target);
			// Claim the active slot before awaiting start(): a second
			// start-app-audio-rtp that interleaves at the await must be able to stop
			// this sender, otherwise its UDP socket leaks for the process lifetime.
			// pushPcm is a no-op until start() completes, so early assignment is safe.
			appAudioRtpSender = sender;

			try {
				await sender.start();
			} catch (error) {
				if (appAudioRtpSender === sender) {
					appAudioRtpSender = undefined;
				}
				sender.stop();
				throw error;
			}

			// The client SRTP key the renderer must relay to the server via
			// produceAppAudio so mediasoup can decrypt our RTP.
			return { srtpKeyBase64: sender.getClientSrtpKeyBase64() };
		},
		validateStartAppAudioRtpArgs,
	);

	handleTrusted('desktop:stop-app-audio-rtp', () => {
		stopAppAudioRtpSender();
	});

	handleTrusted(
		'desktop:set-global-push-keybinds',
		async (_event, input?: TDesktopPushKeybindsInput) => {
			return await setGlobalPushKeybinds(input);
		},
		validateSetGlobalPushKeybindsArgs,
	);

	onTrusted('desktop:open-app-audio-frame-channel', (event: IpcMainEvent) => {
		// Opening the worklet egress means the renderer is taking the fallback path;
		// native RTP ingest must not also be consuming the egress.
		stopAppAudioRtpSender();

		const { port1, port2 } = new MessageChannelMain();
		disposeAppAudioFrameEgressPort();

		appAudioFrameEgressPort = port2;
		port2.on('close', () => {
			if (appAudioFrameEgressPort === port2) {
				appAudioFrameEgressPort = undefined;
			}
			port2.removeAllListeners();
		});

		port2.start();
		event.sender.postMessage('desktop:app-audio-frame-channel-ready', null, [port1]);
	});

	onTrusted(
		'desktop:before-quit-finished',
		(_event: IpcMainEvent, result: TDesktopQuitFlushResult) => {
			completeDesktopQuitFlush(result);
		},
		validateDesktopQuitFlushResultArgs,
	);

	handleTrusted('desktop:debug-request-before-quit-flush', async () => {
		if (!DESKTOP_DEBUG_IPC_ENABLED) {
			return {
				status: 'skipped',
				reason: 'debug-unavailable',
			};
		}

		if (appIsShuttingDown || desktopQuitFlushInterceptInProgress) {
			return {
				status: 'skipped',
				reason: 'quit-in-progress',
			};
		}

		return await requestDesktopQuitFlush();
	});

	handleTrusted('desktop:ping-sidecar', () => {
		return captureSidecarManager.getStatus();
	});

	handleTrusted('desktop:get-update-status', () => {
		return desktopUpdater.getStatus();
	});

	handleTrusted('desktop:check-for-updates', async () => {
		await desktopUpdater.checkForUpdates();
		return desktopUpdater.getStatus();
	});

	handleTrusted('desktop:list-share-sources', () => {
		return listShareSources();
	});

	handleTrusted('desktop:reset-screen-share-picker', () => {
		// Also drop any armed source grant: when the macOS 15+ native picker handled
		// the request, the prepared source was never consumed and would stay queued.
		clearPreparedScreenShareSelection();
		setDisplayMediaUseSystemPicker(false);
	});

	handleTrusted(
		'desktop:prepare-screen-share',
		async (_event: IpcMainInvokeEvent, selection: TScreenShareSelection) => {
			const capabilities = await getEffectiveDesktopCapabilities();
			const resolved = resolvePreparedScreenAudioMode(selection, capabilities);

			setDisplayMediaUseSystemPicker(selection.useSystemPicker ?? false);

			// Always prepare a source, even when useSystemPicker is requested: the
			// native system picker is macOS 15+ only, so on Windows/Linux (and older
			// macOS) Electron ignores the flag and still invokes our display-media
			// handler, which rejects without a prepared selection. When the native
			// picker does take over (macOS 15+) the prepared source is simply unused.
			prepareScreenShareSelection({
				sourceId: selection.sourceId,
				audioMode: resolved.effectiveMode,
				appAudioTargetId: selection.appAudioTargetId,
			});

			return resolved;
		},
		validatePrepareScreenShareArgs,
	);
};

// Chromium command-line switches that steer GPU video encode. These must be set
// before the GPU process spawns (i.e. before app `ready`), so this runs at module
// load. The renderer's mediaCapabilities probe reports powerEfficient:false for
// every codec when hardware encode is unavailable, silently pushing screen share
// onto software encoders — these switches expose the NVENC hardware paths so
// capable GPUs encode in hardware.
//
// enable-features rationale:
//   - AcceleratedVideoEncoder: master switch for hardware video encode.
//   - D3D12VideoEncodeAccelerator: Windows 11 24H2 (WDDM 3.2) hardware encode path.
//
// With these set (and the Vulkan ANGLE flags gone) the Chromium D3D12 encoder
// runs in hardware: H264 screen share reports encoderImplementation
// "D3D12VideoEncodeAccelerator", powerEfficient true — even though getGPUInfo
// still reports supportsDx12=false (that field is unrelated to the video
// encoder).
//
// ANGLE stays on its Windows default (D3D11) backend. Forcing the Vulkan ANGLE
// backend (use-angle=vulkan + Vulkan/DefaultANGLEVulkan/VulkanFromANGLE) on the
// NVIDIA driver here reported supportsVulkan=false and dropped the whole
// compositor into software (gpu_compositing=disabled_software, WebGL readback),
// which also emptied the hardware video-encode profile list and blocked the
// D3D12 encoder from initializing — i.e. it defeated the purpose of these flags.
//
// Note: VaapiOnNvidiaGPUs / VaapiIgnoreDriverChecks are intentionally omitted —
// VA-API is Linux-only and a no-op on Windows/macOS. Re-add them under a
// `process.platform === "linux"` guard if Linux NVENC support is needed.
//
// HEVC encode flags (PlatformHEVCEncoderSupport / WebRtcAllowH265Send/Receive)
// are deliberately NOT set: the mediasoup SFU (3.19.x) does not support routing
// video/H265, so offering it from the client would only produce a codec the
// router rejects. Revisit if/when the SFU gains H265 support.
const GPU_COMMAND_LINE_SWITCHES: ReadonlyArray<readonly [string, string]> = [
	['enable-features', ['AcceleratedVideoEncoder', 'D3D12VideoEncodeAccelerator'].join(',')],
	// Needed on Windows to let the D3D12 video-encode accelerator initialize on
	// GPUs Chromium blocklisted conservatively. Keep it Windows-only: on Linux it
	// can re-enable Mesa configs Chromium blocked for stability reasons.
	...(process.platform === 'win32' ? ([['ignore-gpu-blocklist', '']] as const) : []),
];

const configureGpuCommandLineSwitches = () => {
	for (const [name, value] of GPU_COMMAND_LINE_SWITCHES) {
		if (value) {
			app.commandLine.appendSwitch(name, value);
		} else {
			app.commandLine.appendSwitch(name);
		}
	}
};

configureGpuCommandLineSwitches();

void app
	.whenReady()
	.then(() => {
		captureSidecarManager.onFrame((frame) => {
			// Native RTP ingest owns the egress — never also forward to the renderer.
			if (appAudioRtpSender || appAudioFrameEgressPort) {
				return;
			}

			sendToRenderer('desktop:app-audio-frame', frame);
		});
		captureSidecarManager.onPcmFrame((frame: TAppAudioPcmFrame) => {
			// Single-active sink: when native ingest is running, encode+send here and
			// do not forward PCM to the renderer worklet pipeline.
			const sender = appAudioRtpSender;
			if (sender) {
				sender.pushPcm({ pcm: frame.pcm, sampleRate: frame.sampleRate, channels: frame.channels });
				return;
			}

			const egressPort = appAudioFrameEgressPort;
			if (!egressPort) {
				return;
			}

			const { pcm } = frame;
			try {
				egressPort.postMessage({
					sessionId: frame.sessionId,
					targetId: frame.targetId,
					sequence: frame.sequence,
					sampleRate: frame.sampleRate,
					channels: frame.channels,
					frameCount: frame.frameCount,
					protocolVersion: frame.protocolVersion,
					droppedFrameCount: frame.droppedFrameCount,
					pcmBuffer: pcm.buffer,
					pcmByteOffset: pcm.byteOffset,
					pcmByteLength: pcm.byteLength,
				});
			} catch {
				disposeAppAudioFrameEgressPort(egressPort);
			}
		});
		captureSidecarManager.onStatus((event) => {
			sendToRenderer('desktop:app-audio-status', event);
		});
		captureSidecarManager.onPushKeybind((event) => {
			emitPushKeybindEvent(event);
		});
		captureSidecarManager.onCrash((event) => {
			// The Rust capture sidecar is a spawned native process, not an Electron
			// child, so the SDK's childProcessIntegration doesn't see it. Report
			// abnormal exits here, with recent stderr (incl. any panic) as context.
			Sentry.captureException(new Error(event.reason), {
				tags: { component: 'capture-sidecar' },
				...(event.stderrTail ? { extra: { sidecarStderr: event.stderrTail } } : {}),
			});
		});
		captureSidecarManager.onLifecycle((event) => {
			if (appIsShuttingDown && event.kind === 'exit') {
				return;
			}

			requestDesktopCapabilitiesRefresh({
				broadcast: true,
			});
		});

		desktopUpdater.start((status) => {
			sendToRenderer('desktop:update-status', status);
		});

		registerIpcHandlers();
		setupPermissionHandlers();
		setupDisplayMediaHandler();
		setupYoutubeEmbedRefererHandler();
		setupRendererCspHandler();
		createMainWindow();
		requestDesktopCapabilitiesRefresh({
			broadcast: true,
			forceBroadcast: true,
		});

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createMainWindow();
			}
		});
	})
	.catch((error) => {
		console.error('[desktop] Failed to initialize app', error);
	});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('before-quit', (event) => {
	appIsShuttingDown = true;

	if (desktopQuitFlushCompleted) {
		disposeDesktopServicesForShutdown();
		return;
	}

	event.preventDefault();

	if (desktopQuitFlushInterceptInProgress) {
		return;
	}

	desktopQuitFlushInterceptInProgress = true;

	void (async () => {
		const result = await requestDesktopQuitFlush();

		if (result.status === 'skipped') {
			console.warn('[desktop] Quit flush skipped', {
				reason: result.reason,
			});
		}

		desktopQuitFlushInterceptInProgress = false;
		desktopQuitFlushCompleted = true;
		app.quit();
	})();
});
