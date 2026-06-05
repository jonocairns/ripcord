import { memo } from 'react';
import { cn } from '@/lib/utils';

type TCardControlsProps = {
	children?: React.ReactNode;
	className?: string;
	visible?: boolean;
};

const CardControls = memo(({ children, className, visible }: TCardControlsProps) => {
	return (
		<div
			className={cn(
				'absolute top-3 right-3 z-20 flex items-center gap-1 rounded-full border border-white/15 bg-black/65 p-1 text-white shadow-lg backdrop-blur-md transition-opacity',
				visible === undefined
					? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
					: visible
						? 'opacity-100'
						: 'pointer-events-none opacity-0',
				'[&_[data-slot=icon-button]]:h-8 [&_[data-slot=icon-button]]:w-8 [&_[data-slot=icon-button]]:rounded-full [&_[data-slot=icon-button]]:text-white/90',
				'[&_[data-slot=icon-button]:hover]:bg-white/15 [&_[data-slot=icon-button]:hover]:text-white',
				'[&_[data-slot=icon-button]:focus-visible]:bg-white/15 [&_[data-slot=icon-button]:focus-visible]:text-white [&_[data-slot=icon-button]:focus-visible]:ring-2 [&_[data-slot=icon-button]:focus-visible]:ring-white/60',
				className,
			)}
		>
			{children}
		</div>
	);
});

export { CardControls };
