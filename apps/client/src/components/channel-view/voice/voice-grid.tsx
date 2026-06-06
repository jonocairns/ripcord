import {
	cloneElement,
	isValidElement,
	memo,
	type ReactElement,
	type ReactNode,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { cn } from '@/lib/utils';
import { VoiceSurface } from './voice-surface';

type TVoiceGridProps = {
	children: ReactNode[];
	pinnedCardId?: string;
	className?: string;
};

type TCardElement = ReactElement<{ className?: string; fitStreamAspect?: boolean }>;

type TRect = { left: number; top: number; width: number; height: number };

type TPlacement = {
	rect: TRect;
	injectClassName?: string;
	fitStreamAspect?: boolean;
};

// Layout constants (px). Tiles are absolutely positioned inside one container so
// that pinning/unpinning only recomputes rects and never moves a card to a new
// parent — keeping every <video> element (and its decoded frames) mounted.
const EDGE = 16;
const GAP = 16;
// Reserve room at the bottom for the floating controls bar.
const BOTTOM_INSET = 112;
const SINGLE_MAX_W = 1024;
const DOCK_THUMB_W = 160;
const DOCK_THUMB_H = 96;
const DOCK_THUMB_MIN_W = 72;
const DOCK_GAP = 10;
const DOCK_PAD = 10;
const DOCK_AVATAR_SHRINK =
	'[&_[data-slot=avatar]]:h-16 [&_[data-slot=avatar]]:w-16 [&_[data-slot=avatar-fallback]]:text-2xl';
const DOCK_AVATAR_COMPACT =
	'[&_[data-slot=avatar]]:h-10 [&_[data-slot=avatar]]:w-10 [&_[data-slot=avatar-fallback]]:text-lg';

const getGridCols = (totalCards: number) => {
	if (totalCards <= 1) return 1;
	if (totalCards <= 4) return 2;
	if (totalCards <= 9) return 3;
	if (totalCards <= 16) return 4;

	return 5;
};

const isCardElement = (node: ReactNode): node is TCardElement => {
	return isValidElement<{ className?: string; fitStreamAspect?: boolean }>(node);
};

const VoiceGrid = memo(({ children, pinnedCardId, className }: TVoiceGridProps) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useLayoutEffect(() => {
		const el = containerRef.current;

		if (!el) return;

		const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });

		update();

		const observer = new ResizeObserver(update);
		observer.observe(el);

		return () => observer.disconnect();
	}, []);

	const { cards, placements, dockBar } = useMemo(() => {
		const childArray = (Array.isArray(children) ? children : [children]).filter(isCardElement);
		const keyOf = (card: TCardElement) => String(card.key);

		const { width: W, height: H } = size;
		const x0 = EDGE;
		const y0 = EDGE;
		const usableW = Math.max(0, W - EDGE * 2);
		const usableH = Math.max(0, H - EDGE - BOTTOM_INSET);

		const placements = new Map<string, TPlacement>();
		let dockBar: TRect | null = null;

		const pinned = pinnedCardId ? childArray.find((card) => keyOf(card) === pinnedCardId) : undefined;

		if (pinned) {
			const regulars = childArray.filter((card) => keyOf(card) !== pinnedCardId);
			const hasDock = regulars.length > 0;
			const availableDockW = Math.max(0, usableW - DOCK_PAD * 2);
			const dockCols = hasDock
				? Math.min(
						regulars.length,
						Math.max(1, Math.floor((availableDockW + DOCK_GAP) / (DOCK_THUMB_MIN_W + DOCK_GAP))),
					)
				: 0;
			const dockRows = dockCols > 0 ? Math.ceil(regulars.length / dockCols) : 0;
			const thumbW =
				dockCols > 0 ? Math.max(0, Math.min(DOCK_THUMB_W, (availableDockW - (dockCols - 1) * DOCK_GAP) / dockCols)) : 0;
			const thumbH = (thumbW * DOCK_THUMB_H) / DOCK_THUMB_W;
			const dockContentH = dockRows * thumbH + Math.max(0, dockRows - 1) * DOCK_GAP;
			const dockContentW = Math.min(
				usableW,
				Math.min(regulars.length, dockCols) * thumbW +
					Math.max(0, Math.min(regulars.length, dockCols) - 1) * DOCK_GAP +
					DOCK_PAD * 2,
			);
			const dockReserve = hasDock ? GAP + dockContentH + DOCK_PAD * 2 : 0;
			const mainH = Math.max(0, usableH - dockReserve);

			placements.set(keyOf(pinned), { rect: { left: x0, top: y0, width: usableW, height: mainH } });

			if (hasDock) {
				const bandTop = y0 + mainH + GAP;
				const thumbTop = bandTop + DOCK_PAD;

				dockBar = {
					left: x0 + Math.max(0, (usableW - dockContentW) / 2),
					top: bandTop,
					width: dockContentW,
					height: dockContentH + DOCK_PAD * 2,
				};

				regulars.forEach((card, index) => {
					const row = Math.floor(index / dockCols);
					const col = index % dockCols;
					const rowStartIndex = row * dockCols;
					const cardsInRow = Math.min(dockCols, regulars.length - rowStartIndex);
					const rowW = cardsInRow * thumbW + Math.max(0, cardsInRow - 1) * DOCK_GAP;
					const startLeft = x0 + Math.max(0, (usableW - rowW) / 2);

					placements.set(keyOf(card), {
						rect: {
							left: startLeft + col * (thumbW + DOCK_GAP),
							top: thumbTop + row * (thumbH + DOCK_GAP),
							width: thumbW,
							height: thumbH,
						},
						injectClassName: thumbH < 80 ? DOCK_AVATAR_COMPACT : DOCK_AVATAR_SHRINK,
					});
				});
			}

			return { cards: childArray, placements, dockBar };
		}

		if (childArray.length === 1) {
			const card = childArray[0];
			const width = Math.min(usableW, SINGLE_MAX_W);

			placements.set(keyOf(card), {
				rect: { left: x0 + (usableW - width) / 2, top: y0, width, height: usableH },
				fitStreamAspect: keyOf(card).startsWith('screen-share-'),
			});

			return { cards: childArray, placements, dockBar };
		}

		const cols = getGridCols(childArray.length);
		const rows = Math.ceil(childArray.length / cols);
		const cellW = (usableW - (cols - 1) * GAP) / cols;
		const cellH = (usableH - (rows - 1) * GAP) / rows;

		childArray.forEach((card, index) => {
			const row = Math.floor(index / cols);
			const col = index % cols;

			placements.set(keyOf(card), {
				rect: {
					left: x0 + col * (cellW + GAP),
					top: y0 + row * (cellH + GAP),
					width: cellW,
					height: cellH,
				},
			});
		});

		return { cards: childArray, placements, dockBar };
	}, [children, pinnedCardId, size]);

	return (
		<div ref={containerRef} className={cn('relative h-full w-full overflow-hidden', className)}>
			{dockBar && (
				<VoiceSurface
					variant="dock"
					clip={false}
					className="pointer-events-none absolute"
					style={{ left: dockBar.left, top: dockBar.top, width: dockBar.width, height: dockBar.height }}
				/>
			)}

			{cards.map((card) => {
				const placement = placements.get(String(card.key));

				if (!placement) return null;

				const { rect, injectClassName, fitStreamAspect } = placement;
				const child =
					injectClassName || fitStreamAspect
						? cloneElement(card, {
								...(injectClassName ? { className: cn(card.props.className, injectClassName) } : {}),
								...(fitStreamAspect ? { fitStreamAspect: true } : {}),
							})
						: card;

				return (
					<div
						key={card.key}
						className="absolute flex items-center justify-center"
						style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
					>
						{child}
					</div>
				);
			})}
		</div>
	);
});

export { VoiceGrid };
