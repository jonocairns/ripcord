import { reportErrorToSentry } from './sentry-client';

let installed = false;

const describeReason = (reason: unknown): string => {
	if (reason instanceof Error) {
		return reason.message;
	}

	if (typeof reason === 'string') {
		return reason;
	}

	try {
		return JSON.stringify(reason);
	} catch {
		return String(reason);
	}
};

const installGlobalErrorHandlers = () => {
	if (installed || typeof window === 'undefined') {
		return;
	}

	installed = true;

	window.addEventListener('error', (event) => {
		// Resource-load failures (img, script, link) bubble here without `event.error`.
		// Skip them — they are noise, not app exceptions.
		if (!event.error) {
			return;
		}

		void reportErrorToSentry(event.message || 'Uncaught error', event.error, {
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
		});
	});

	window.addEventListener('unhandledrejection', (event) => {
		const reason = event.reason;
		const error = reason instanceof Error ? reason : undefined;

		void reportErrorToSentry('Unhandled promise rejection', error, {
			reason: describeReason(reason),
		});
	});
};

export { installGlobalErrorHandlers };
