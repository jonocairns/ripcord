import { describe, expect, it } from 'bun:test';
import {
	finishMediaRefresh,
	INITIAL_MEDIA_RETRY_STATE,
	isMediaUnavailable,
	resolveMediaLoadError,
} from '../media-retry';

const OLD_URL = 'https://chat.example/public/a.png?accessToken=old&v=1';
const NEW_URL = 'https://chat.example/public/a.png?accessToken=new&v=1';

describe('media retry', () => {
	it('refreshes once on the first tokened failure', () => {
		const { state, refresh } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);

		expect(refresh).toBe(true);
		expect(state.refreshing).toBe(true);
		expect(isMediaUnavailable(state, OLD_URL)).toBe(false);
	});

	it('shows the file as unavailable when the retry fails too', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);
		const refreshed = finishMediaRefresh(first.state);
		const second = resolveMediaLoadError(refreshed, NEW_URL, true);

		expect(second.refresh).toBe(false);
		expect(isMediaUnavailable(second.state, NEW_URL)).toBe(true);
	});

	it('ignores repeat errors while the refresh runs', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);
		const repeat = resolveMediaLoadError(first.state, OLD_URL, true);

		expect(repeat.refresh).toBe(false);
		expect(repeat.state).toBe(first.state);
	});

	it('does not refresh a file without a token', () => {
		const { state, refresh } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, false);

		expect(refresh).toBe(false);
		expect(isMediaUnavailable(state, OLD_URL)).toBe(true);
	});

	it('tries a newer link after the file was marked unavailable', () => {
		const { state } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, false);

		expect(isMediaUnavailable(state, NEW_URL)).toBe(false);
	});
});
