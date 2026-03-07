import { IconButton } from '@/components/ui/icon-button';
import { Pin, PinOff } from 'lucide-react';
import { memo } from 'react';

type TPinButtonProps = {
  isPinned: boolean;
  handlePinToggle: () => void;
  className?: string;
  size?: 'sm' | 'default' | 'lg' | 'xl' | 'xs';
};

const PinButton = memo(
  ({ isPinned, handlePinToggle, className, size = 'sm' }: TPinButtonProps) => {
    return (
      <IconButton
        variant={isPinned ? 'default' : 'ghost'}
        icon={isPinned ? PinOff : Pin}
        onClick={handlePinToggle}
        title={isPinned ? 'Unpin' : 'Pin'}
        size={size}
        className={className}
      />
    );
  }
);

export { PinButton };
