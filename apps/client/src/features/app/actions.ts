import type { TServerInfo } from '@sharkord/shared';
import { toast } from 'sonner';
import { configureClientErrorReporting } from '@/helpers/browser-logger';
import { getUrlFromServer } from '@/helpers/get-file-url';
import { clearAuthToken, getAuthToken, getRefreshToken, hydrateSessionToken } from '@/helpers/storage';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { connect, setDisconnectInfo, setInfo } from '../server/actions';
import { useAppStore } from './slice';

export const setAppLoading = (loading: boolean) => useAppStore.setState({ loading });

export const fetchServerInfo = async (): Promise<TServerInfo | undefined> => {
	try {
		const url = getUrlFromServer();
		const response = await fetch(`${url}/info`);

		if (!response.ok) {
			throw new Error('Failed to fetch server info');
		}

		const data = await response.json();

		return data;
	} catch (error) {
		console.error('Error fetching server info:', error);
	}
};

export const loadApp = async () => {
	try {
		const info = await fetchServerInfo();

		if (!info) {
			console.error('Failed to load server info during app load');
			toast.error('Failed to load server info');
			return;
		}

		const sentryDsn =
			info.clientErrorReporting?.provider === 'sentry' ? info.clientErrorReporting.dsn : undefined;

		configureClientErrorReporting({
			sentryDsn,
			ignoreErrors: info.clientErrorReporting?.ignoreErrors,
			tracingSampleRate: info.clientErrorReporting?.tracingSampleRate,
		});

		// Forward the same per-server DSN to the Electron main process, which has no
		// DSN of its own, so main-process JS errors and native crashes report too.
		void getDesktopBridge()?.configureErrorReporting?.({
			dsn: sentryDsn,
			ignoreErrors: info.clientErrorReporting?.ignoreErrors,
			tracingSampleRate: info.clientErrorReporting?.tracingSampleRate,
		});

		setInfo(info);

		const existingToken = getAuthToken();
		const existingRefreshToken = getRefreshToken();

		if (existingToken || existingRefreshToken) {
			hydrateSessionToken();

			try {
				await connect();
			} catch (error) {
				console.error('Failed to auto-connect with persisted auth token', error);

				if (existingToken && !existingRefreshToken) {
					clearAuthToken();
				}

				if (!getAuthToken() && !getRefreshToken()) {
					setDisconnectInfo(undefined);
				}
			}
		}
	} finally {
		setAppLoading(false);
	}
};

export const setModViewOpen = (isOpen: boolean, userId?: number) =>
	useAppStore.setState({
		modViewOpen: isOpen,
		modViewUserId: userId,
	});

export const resetApp = () => {
	useAppStore.setState({
		modViewOpen: false,
		modViewUserId: undefined,
	});
};
