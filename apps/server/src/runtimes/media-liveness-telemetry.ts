import { logger } from '../logger';
import { Sentry } from '../sentry';

// The media-liveness watchdog is an automated remediation, so we want a baseline
// on how often it fires — but reported in a way that cannot spam Sentry. A
// global media failure (e.g. the SFU's UDP path dies) trips the watchdog for
// every consumer at once, so capturing one Sentry event per fire would flood the
// project at the exact moment something is wrong. Instead we aggregate fires into
// a rolling window and emit at most ONE summary event per interval, only when
// there was at least one fire. Per-fire detail (with ids) still lands in app.log;
// the Sentry summary carries counts only, so it is both non-spammy and PII-free.
const MEDIA_LIVENESS_REPORT_INTERVAL_MS = 5 * 60_000;

type TMediaLivenessWindow = {
	fires: number;
	users: Set<number>;
	channels: Set<number>;
	firstAt: number;
};

let activeWindow: TMediaLivenessWindow | undefined;
let reportTimer: ReturnType<typeof setInterval> | undefined;

const stopReportTimer = () => {
	if (reportTimer) {
		clearInterval(reportTimer);
		reportTimer = undefined;
	}
};

const flushMediaLivenessReport = () => {
	const current = activeWindow;
	activeWindow = undefined;

	// Nothing fired this interval — stand the timer down so an idle server keeps
	// no live timer. The next fire restarts it.
	if (!current || current.fires === 0) {
		stopReportTimer();
		return;
	}

	const summary = {
		fires: current.fires,
		distinctUsers: current.users.size,
		distinctChannels: current.channels.size,
		windowMs: Date.now() - current.firstAt,
	};

	logger.warn('[voice] media-liveness summary %o', summary);

	// `level: 'warning'` keeps these out of the error stream; counts only, no ids.
	// A no-op when Sentry has no DSN configured (self-hosted / dev).
	Sentry.captureMessage('voice.media_liveness_timeouts', {
		level: 'warning',
		extra: summary,
	});
};

const ensureReportTimer = () => {
	if (reportTimer) {
		return;
	}

	reportTimer = setInterval(flushMediaLivenessReport, MEDIA_LIVENESS_REPORT_INTERVAL_MS);
	reportTimer.unref?.();
};

// Record one watchdog fire. Increments the rolling window and ensures the summary
// timer is running; the window is reported and reset on the next flush.
const recordMediaLivenessFailure = (channelId: number, userId: number) => {
	if (!activeWindow) {
		activeWindow = { fires: 0, users: new Set(), channels: new Set(), firstAt: Date.now() };
	}

	activeWindow.fires += 1;
	activeWindow.users.add(userId);
	activeWindow.channels.add(channelId);

	ensureReportTimer();
};

// Current rolling-window aggregate (counts only), or undefined when nothing has
// fired since the last flush.
const getMediaLivenessTelemetrySnapshot = () =>
	activeWindow
		? {
				fires: activeWindow.fires,
				distinctUsers: activeWindow.users.size,
				distinctChannels: activeWindow.channels.size,
			}
		: undefined;

const resetMediaLivenessTelemetryForTests = () => {
	stopReportTimer();
	activeWindow = undefined;
};

export {
	flushMediaLivenessReport,
	getMediaLivenessTelemetrySnapshot,
	MEDIA_LIVENESS_REPORT_INTERVAL_MS,
	recordMediaLivenessFailure,
	resetMediaLivenessTelemetryForTests,
};
