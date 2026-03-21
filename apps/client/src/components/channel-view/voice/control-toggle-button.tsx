import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type TIconComponent = React.ComponentType<{
	size?: number;
	className?: string;
}>;

type TControlToggleButtonProps = {
	enabled: boolean;
	enabledLabel: string;
	disabledLabel: string;
	enabledIcon: TIconComponent;
	disabledIcon: TIconComponent;

	enabledClassName: string;
	disabledClassName?: string;

	onClick: () => void;
	disabled?: boolean;
};

const ControlToggleButton = memo(
	({
		enabled,
		enabledLabel,
		disabledLabel,
		enabledIcon: EnabledIcon,
		disabledIcon: DisabledIcon,
		enabledClassName,
		disabledClassName,
		onClick,
		disabled,
	}: TControlToggleButtonProps) => {
		const label = enabled ? enabledLabel : disabledLabel;

		return (
			<Tooltip content={label}>
				<Button
					variant="ghost"
					size="icon"
					className={cn(
						'h-10 w-10 rounded-xl border border-transparent bg-transparent transition-[background-color,border-color,color,transform] duration-150 active:scale-95',
						enabled
							? enabledClassName
							: (disabledClassName ?? 'hover:!bg-muted/60 hover:!text-foreground text-muted-foreground'),
						disabled && 'opacity-60 hover:!bg-transparent',
					)}
					onClick={onClick}
					disabled={disabled}
					aria-label={label}
				>
					{enabled ? <EnabledIcon size={22} /> : <DisabledIcon size={22} />}
				</Button>
			</Tooltip>
		);
	},
);

ControlToggleButton.displayName = 'ControlToggleButton';

export type { TControlToggleButtonProps };
export { ControlToggleButton };
