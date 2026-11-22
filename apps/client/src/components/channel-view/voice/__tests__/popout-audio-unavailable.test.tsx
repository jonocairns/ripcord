import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PopoutAudioUnavailable } from '../popout-volume-panel';

const retry = () => {};

describe('PopoutAudioUnavailable', () => {
	test('offers retry while screen audio is connecting or failed', () => {
		const connecting = renderToStaticMarkup(<PopoutAudioUnavailable status="connecting" onRetry={retry} />);
		const failed = renderToStaticMarkup(<PopoutAudioUnavailable status="failed" onRetry={retry} />);

		expect(connecting).toContain('<button');
		expect(connecting).toContain('aria-label="Screen audio connecting. Retry"');
		expect(failed).toContain('data-status="failed"');
		expect(failed).toContain('aria-label="Screen audio unavailable. Retry"');
	});

	test('only labels the slot when there is nothing to retry', () => {
		const none = renderToStaticMarkup(<PopoutAudioUnavailable status="none" onRetry={retry} />);
		const stopped = renderToStaticMarkup(<PopoutAudioUnavailable status="stopped" onRetry={retry} />);
		const failedWithoutRetry = renderToStaticMarkup(<PopoutAudioUnavailable status="failed" />);

		for (const html of [none, stopped, failedWithoutRetry]) {
			expect(html).not.toContain('<button');
		}
		expect(none).toContain('aria-label="No audio in this share"');
		expect(stopped).toContain('aria-label="Screen audio stopped"');
	});
});
