import type { LucideIcon } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

type TControlButtonProps = React.ComponentPropsWithoutRef<'button'> & {
	icon: LucideIcon;
	active?: boolean;
};

// The single shell every voice card control renders through. Any control — plain
// button, popover trigger (via asChild), pin — gets the exact same box, surface,
// icon size and states. Add a new control by passing an icon; never restyle here
// per-control.
const ControlButton = forwardRef<HTMLButtonElement, TControlButtonProps>(
	({ icon: Icon, active = false, className, type = 'button', ...props }, ref) => {
		return (
			<button
				ref={ref}
				type={type}
				data-slot="control-button"
				className={cn(
					'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-zinc-800/90 text-white/90 shadow-md ring-1 ring-black/30 outline-none backdrop-blur-md transition-colors',
					'hover:bg-zinc-700/90 hover:text-white',
					'focus-visible:ring-2 focus-visible:ring-white/60',
					'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
					active && 'bg-white/20 text-white ring-white/40',
					className,
				)}
				{...props}
			>
				<Icon className="size-4" />
			</button>
		);
	},
);

ControlButton.displayName = 'ControlButton';

export { ControlButton };
