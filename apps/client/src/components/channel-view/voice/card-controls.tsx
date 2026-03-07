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
        'absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100',
        className
      )}
    >
      {children}
    </div>
  );
});

export { CardControls };
