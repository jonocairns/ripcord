import { cn } from '@/lib/utils';
import { memo } from 'react';

type TCardControlsProps = {
  children?: React.ReactNode;
  className?: string;
};

const CardControls = memo(({ children, className }: TCardControlsProps) => {
  return (
    <div
      className={cn(
        'absolute top-3 right-3 z-10 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100',
        className
      )}
    >
      {children}
    </div>
  );
});

export { CardControls };
