import { describe, expect, it } from 'bun:test';
import { reduceChatComposerLayout, type TChatComposerLayoutMode } from '../chat-composer-layout';

describe('chat composer layout', () => {
	it('enters multiline mode when the inline editor wraps', () => {
		expect(reduceChatComposerLayout('inline', { type: 'editor-resized', isWrapped: true })).toBe('multiline');
	});

	it('ignores the unwrapped measurement caused by widening the multiline editor', () => {
		expect(reduceChatComposerLayout('multiline', { type: 'editor-resized', isWrapped: false })).toBe('multiline');
	});

	it('returns to multiline when an inline probe still wraps', () => {
		let mode: TChatComposerLayoutMode = 'multiline';

		mode = reduceChatComposerLayout(mode, { type: 'inline-probe-requested' });
		expect(mode).toBe('inline-probe');

		mode = reduceChatComposerLayout(mode, { type: 'inline-probe-completed', isWrapped: true });
		expect(mode).toBe('multiline');
	});

	it('collapses after edited content fits in the inline layout', () => {
		let mode: TChatComposerLayoutMode = 'multiline';

		mode = reduceChatComposerLayout(mode, { type: 'inline-probe-requested' });
		mode = reduceChatComposerLayout(mode, { type: 'inline-probe-completed', isWrapped: false });

		expect(mode).toBe('inline');
	});

	it('ignores stale probe results after another measurement has restored multiline mode', () => {
		let mode: TChatComposerLayoutMode = 'inline-probe';

		mode = reduceChatComposerLayout(mode, { type: 'editor-resized', isWrapped: true });
		mode = reduceChatComposerLayout(mode, { type: 'inline-probe-completed', isWrapped: false });

		expect(mode).toBe('multiline');
	});
});
