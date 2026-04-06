import { useCallback, useEffect, useRef } from 'react';

// TODO: this might be improved in the future

type TUseScrollControllerProps = {
	messages: unknown[];
	fetching: boolean;
	hasMore: boolean;
	loadMore: () => Promise<unknown>;
};

type TUseScrollControllerReturn = {
	containerRef: React.RefObject<HTMLDivElement | null>;
	onScroll: () => void;
	scrollToBottom: () => void;
};

const useScrollController = ({
	messages,
	fetching,
	hasMore,
	loadMore,
}: TUseScrollControllerProps): TUseScrollControllerReturn => {
	const containerRef = useRef<HTMLDivElement>(null);
	const hasInitialScroll = useRef(false);
	const shouldStickToBottom = useRef(true);

	const isNearBottom = useCallback((container: HTMLDivElement) => {
		const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);

		return distanceFromBottom <= 120;
	}, []);

	// scroll to bottom function
	const scrollToBottom = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;

		container.scrollTop = container.scrollHeight;
	}, []);

	// detect scroll-to-top and load more messages
	const onScroll = useCallback(() => {
		const container = containerRef.current;

		if (!container) return;

		shouldStickToBottom.current = isNearBottom(container);

		if (fetching) return;

		if (container.scrollTop <= 50 && hasMore) {
			const prevScrollHeight = container.scrollHeight;

			loadMore().then(() => {
				const newScrollHeight = container.scrollHeight;

				container.scrollTop = newScrollHeight - prevScrollHeight + container.scrollTop;
				shouldStickToBottom.current = isNearBottom(container);
			});
		}
	}, [loadMore, hasMore, fetching, isNearBottom]);

	// Handle initial scroll after messages load
	useEffect(() => {
		if (!containerRef.current) return;
		if (fetching || messages.length === 0) return;

		if (!hasInitialScroll.current) {
			// Immediate attempt, then one RAF for any pending layout work.
			// Late-loading images/media are handled by the ResizeObserver below.
			scrollToBottom();
			hasInitialScroll.current = true;
			shouldStickToBottom.current = true;

			requestAnimationFrame(() => {
				scrollToBottom();
			});
		}
	}, [fetching, messages.length, scrollToBottom]);

	// auto-scroll on new messages if user is near bottom
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !hasInitialScroll.current || messages.length === 0) return;

		if (shouldStickToBottom.current) {
			// scroll after a short delay to allow content to render
			setTimeout(() => {
				scrollToBottom();
			}, 10);
		}
	}, [messages, scrollToBottom]);

	// keep bottom lock on container resize (input/footer height changes)
	useEffect(() => {
		const container = containerRef.current;

		if (!container) {
			return;
		}

		const observer = new ResizeObserver(() => {
			if (!shouldStickToBottom.current) {
				return;
			}

			scrollToBottom();
		});

		observer.observe(container);

		return () => {
			observer.disconnect();
		};
	}, [scrollToBottom]);

	return {
		containerRef,
		onScroll,
		scrollToBottom,
	};
};

export { useScrollController };
