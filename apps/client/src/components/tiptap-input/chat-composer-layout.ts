type TChatComposerLayoutMode = 'inline' | 'inline-probe' | 'multiline';

type TChatComposerLayoutEvent =
	| { type: 'editor-resized'; isWrapped: boolean }
	| { type: 'inline-probe-requested' }
	| { type: 'inline-probe-completed'; isWrapped: boolean };

const reduceChatComposerLayout = (
	mode: TChatComposerLayoutMode,
	event: TChatComposerLayoutEvent,
): TChatComposerLayoutMode => {
	switch (event.type) {
		case 'editor-resized':
			// The multiline layout gives the editor more width, so a one-line result
			// there cannot prove that the narrower inline layout would also fit.
			return event.isWrapped ? 'multiline' : mode;
		case 'inline-probe-requested':
			return mode === 'multiline' ? 'inline-probe' : mode;
		case 'inline-probe-completed':
			if (mode !== 'inline-probe') return mode;

			return event.isWrapped ? 'multiline' : 'inline';
	}
};

export type { TChatComposerLayoutEvent, TChatComposerLayoutMode };
export { reduceChatComposerLayout };
