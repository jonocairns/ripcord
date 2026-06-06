import { memo } from 'react';
import { cn } from '@/lib/utils';

type TCardControlsProps = {
	children?: React.ReactNode;
	className?: string;
	// `undefined` keeps the default hover/focus reveal; `true`/`false` lets fullscreen
	// idle logic drive visibility directly.
	visible?: boolean;
};

// Positioned layout only — every child styles itself via ControlButton so the
// controls stay uniform regardless of which component renders them.
const CardControls = memo(({ children, className, visible }: TCardControlsProps) => {
	return (
		<div
			className={cn(
				'absolute top-3 right-3 z-20 flex items-center gap-1.5 transition-opacity',
				visible === undefined
					? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
					: visible
						? 'opacity-100'
						: 'pointer-events-none opacity-0',
				className,
			)}
		>
			{children}
		</div>
	);
});

export { CardControls };
