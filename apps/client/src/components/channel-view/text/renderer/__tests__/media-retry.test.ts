import { describe, expect, it } from 'bun:test';
import {
	finishMediaRefresh,
	getMediaSrc,
	INITIAL_MEDIA_RETRY_STATE,
	isMediaUnavailable,
	markMediaLoaded,
	resolveMediaLoadError,
} from '../media-retry';

const OLD_URL = 'https://chat.example/public/a.png?accessToken=old&v=1';
const NEW_URL = 'https://chat.example/public/a.png?accessToken=new&v=1';
const NEWER_URL = 'https://chat.example/public/a.png?accessToken=newer&v=1';

describe('media source', () => {
	it('uses the stored link before the first load', () => {
		expect(getMediaSrc(INITIAL_MEDIA_RETRY_STATE, OLD_URL)).toBe(OLD_URL);
		expect(getMediaSrc(INITIAL_MEDIA_RETRY_STATE, NEW_URL)).toBe(NEW_URL);
	});

	it('keeps a loaded player on its link when a refresh changes the stored one', () => {
		const loaded = markMediaLoaded(INITIAL_MEDIA_RETRY_STATE, OLD_URL);

		expect(getMediaSrc(loaded, NEW_URL)).toBe(OLD_URL);
		expect(markMediaLoaded(loaded, OLD_URL)).toBe(loaded);
	});

	it('takes the newer stored link after the loaded one fails, without a refresh', () => {
		const loaded = markMediaLoaded(INITIAL_MEDIA_RETRY_STATE, OLD_URL);
		const { state, refresh } = resolveMediaLoadError(loaded, OLD_URL, NEW_URL, true);

		expect(refresh).toBe(false);
		expect(getMediaSrc(state, NEW_URL)).toBe(NEW_URL);
		expect(isMediaUnavailable(state, NEW_URL)).toBe(false);
	});
});

describe('media retry', () => {
	it('refreshes once on the first tokened failure', () => {
		const { state, refresh } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, true);

		expect(refresh).toBe(true);
		expect(state.refreshing).toBe(true);
		expect(isMediaUnavailable(state, OLD_URL)).toBe(false);
	});

	it('refreshes again when a loaded player fails on the stored link', () => {
		const loaded = markMediaLoaded(INITIAL_MEDIA_RETRY_STATE, OLD_URL);
		const { state, refresh } = resolveMediaLoadError(loaded, OLD_URL, OLD_URL, true);

		expect(refresh).toBe(true);
		expect(state.loadedUrl).toBeUndefined();
	});

	it('ignores repeat errors while the refresh runs', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, true);
		const repeat = resolveMediaLoadError(first.state, OLD_URL, OLD_URL, true);

		expect(repeat.refresh).toBe(false);
		expect(repeat.state).toBe(first.state);
	});

	it('gives a later link its own refresh after an earlier recovery', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, true);
		const recovered = markMediaLoaded(finishMediaRefresh(first.state), NEW_URL);
		// NEW_URL loaded fine; a later rotation (event missed) breaks it.
		const second = resolveMediaLoadError(recovered, NEW_URL, NEW_URL, true);

		expect(second.refresh).toBe(true);

		const third = resolveMediaLoadError(finishMediaRefresh(second.state), NEWER_URL, NEWER_URL, true);

		expect(third.refresh).toBe(true);
	});

	it('does not loop when the refresh returns the same link', () => {
		const first = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, true);
		const sameLinkAgain = resolveMediaLoadError(finishMediaRefresh(first.state), OLD_URL, OLD_URL, true);

		expect(sameLinkAgain.refresh).toBe(false);
		expect(isMediaUnavailable(sameLinkAgain.state, OLD_URL)).toBe(true);
	});

	it('does not refresh a file without a token', () => {
		const { state, refresh } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, false);

		expect(refresh).toBe(false);
		expect(isMediaUnavailable(state, OLD_URL)).toBe(true);
	});

	it('tries a newer link after the file was marked unavailable', () => {
		const { state } = resolveMediaLoadError(INITIAL_MEDIA_RETRY_STATE, OLD_URL, OLD_URL, false);

		expect(isMediaUnavailable(state, getMediaSrc(state, NEW_URL))).toBe(false);
	});
});
