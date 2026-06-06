import { Pin, PinOff } from 'lucide-react';
import { memo } from 'react';
import { ControlButton } from './control-button';

type TPinButtonProps = {
	isPinned: boolean;
	handlePinToggle: () => void;
	className?: string;
};

const PinButton = memo(({ isPinned, handlePinToggle, className }: TPinButtonProps) => {
	return (
		<ControlButton
			active={isPinned}
			icon={isPinned ? PinOff : Pin}
			onClick={handlePinToggle}
			title={isPinned ? 'Unpin' : 'Pin'}
			className={className}
		/>
	);
});

export { PinButton };
