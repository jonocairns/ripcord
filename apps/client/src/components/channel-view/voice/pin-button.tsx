import { Button } from '@/components/ui/button';
import { Pin, PinOff } from 'lucide-react';
import { memo } from 'react';

type TPinButtonProps = {
  isPinned: boolean;
  handlePinToggle: () => void;
};

const PinButton = memo(({ isPinned, handlePinToggle }: TPinButtonProps) => {
  return (
    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
      <Button
        variant="secondary"
        size="icon"
        className="h-8 w-8 bg-black/50 hover:bg-black/70 border-0"
        onClick={handlePinToggle}
      >
        {isPinned ? (
          <PinOff className="h-4 w-4 text-white" />
        ) : (
          <Pin className="h-4 w-4 text-white" />
        )}
      </Button>
    </div>
  );
});

export { PinButton };
