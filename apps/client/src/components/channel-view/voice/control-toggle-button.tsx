import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { memo } from 'react';

type TIconComponent = React.ComponentType<{
  size?: number;
  className?: string;
}>;

type TControlToggleButtonProps = {
  enabled: boolean;
  enabledLabel: string;
  disabledLabel: string;
  visibleLabel?: string;
  showLabel?: boolean;
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
    visibleLabel,
    showLabel = true,
    enabledIcon: EnabledIcon,
    disabledIcon: DisabledIcon,
    enabledClassName,
    disabledClassName,
    onClick,
    disabled
  }: TControlToggleButtonProps) => {
    const label = enabled ? enabledLabel : disabledLabel;

    return (
      <Tooltip content={label}>
        <Button
          variant="ghost"
          className={cn(
            showLabel
              ? 'h-10 min-w-[3.25rem] rounded-lg px-2 py-1'
              : 'h-10 w-10 rounded-lg p-0',
            showLabel ? 'flex-col gap-1' : 'shrink-0',
            'transition-all duration-200',
            enabled
              ? enabledClassName
              : (disabledClassName ?? 'hover:bg-muted/60'),
            disabled && 'opacity-60 hover:bg-transparent'
          )}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {enabled ? <EnabledIcon size={18} /> : <DisabledIcon size={18} />}
          {showLabel && (
            <span className="text-[9px] font-medium leading-none">
              {visibleLabel ?? label}
            </span>
          )}
        </Button>
      </Tooltip>
    );
  }
);

ControlToggleButton.displayName = 'ControlToggleButton';

export { ControlToggleButton };
export type { TControlToggleButtonProps };
