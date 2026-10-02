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

	it('shows the file as unavailable when the refreshed link fails too', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);
		const refreshed = finishMediaRefresh(first.state);
		const second = resolveMediaLoadError(refreshed, NEW_URL, true);
		const third = resolveMediaLoadError(finishMediaRefresh(second.state), NEW_URL, true);

		expect(third.refresh).toBe(false);
		expect(isMediaUnavailable(third.state, NEW_URL)).toBe(true);
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

	it('gives a later link its own refresh after an earlier recovery', () => {
		const ROTATED_AGAIN_URL = 'https://chat.example/public/a.png?accessToken=newer&v=1';
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);
		const recovered = finishMediaRefresh(first.state);
		// NEW_URL loaded fine; a later rotation (event missed) breaks it.
		const second = resolveMediaLoadError(recovered, NEW_URL, true);

		expect(second.refresh).toBe(true);
		expect(isMediaUnavailable(second.state, NEW_URL)).toBe(false);

		const third = resolveMediaLoadError(finishMediaRefresh(second.state), ROTATED_AGAIN_URL, true);

		expect(third.refresh).toBe(true);
	});

	it('does not loop when the refresh returns the same link', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, true);
		const sameLinkAgain = resolveMediaLoadError(finishMediaRefresh(first.state), OLD_URL, true);

		expect(sameLinkAgain.refresh).toBe(false);
		expect(isMediaUnavailable(sameLinkAgain.state, OLD_URL)).toBe(true);
	});

	it('tries a newer link after the file was marked unavailable', () => {
		const { state } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, false);

		expect(isMediaUnavailable(state, NEW_URL)).toBe(false);
	});
});
