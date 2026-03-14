import { cn } from '@/lib/utils';
import {
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  type ReactNode
} from 'react';
import { VoiceSurface } from './voice-surface';

type TVoiceGridProps = {
  children: ReactNode[];
  pinnedCardId?: string;
  className?: string;
};

const VoiceGrid = memo(
  ({ children, pinnedCardId, className }: TVoiceGridProps) => {
    const { gridCols, pinnedCard, regularCards } = useMemo(() => {
      const childArray = Array.isArray(children) ? children : [children];
      const getGridCols = (totalCards: number) => {
        if (totalCards <= 1) return 1;
        if (totalCards <= 4) return 2;
        if (totalCards <= 9) return 3;
        if (totalCards <= 16) return 4;

        return 5;
      };

      if (pinnedCardId) {
        const pinned = childArray.find(
          (child: ReactNode) =>
            isValidElement(child) && child.key === pinnedCardId
        );

        const regular = childArray.filter(
          (child: ReactNode) =>
            !isValidElement(child) || child.key !== pinnedCardId
        );

        if (pinned) {
          return {
            gridCols: regular.length <= 4 ? regular.length : 4,
            pinnedCard: pinned,
            regularCards: regular
          };
        }
      }

      const totalCards = childArray.length;

      return {
        gridCols: getGridCols(totalCards),
        pinnedCard: null,
        regularCards: childArray
      };
    }, [children, pinnedCardId]);

    if (pinnedCardId && pinnedCard) {
      return (
        <div className={cn('flex flex-col h-full', className)}>
          <div className="flex-1 min-h-0 p-3 md:p-4">{pinnedCard}</div>

          {regularCards.length > 0 && (
            <div className="pointer-events-none flex-shrink-0 px-3 md:px-4">
              <VoiceSurface
                variant="dock"
                clip={false}
                className="pointer-events-auto mx-auto flex w-fit max-w-full justify-center gap-2.5 overflow-x-auto p-2.5"
              >
                {regularCards.map((card, index) => (
                  <div key={index} className="h-24 w-40 flex-shrink-0 p-1">
                    {isValidElement<{ className?: string }>(card)
                      ? cloneElement(card, {
                          className: cn(
                            card.props.className,
                            '[&_[data-slot=avatar]]:h-16 [&_[data-slot=avatar]]:w-16 [&_[data-slot=avatar-fallback]]:text-2xl'
                          )
                        })
                      : card}
                  </div>
                ))}
              </VoiceSurface>
            </div>
          )}
        </div>
      );
    }

    const getRowCount = (totalCards: number, cols: number) => {
      return Math.ceil(totalCards / cols);
    };

    const rows = getRowCount(regularCards.length, gridCols);

    if (regularCards.length === 1) {
      return (
        <div
          className={cn(
            'flex h-full items-center justify-center p-4 pb-28 md:pb-32',
            className
          )}
        >
          <div className="h-full w-full max-h-[82vh] max-w-5xl overflow-hidden rounded-2xl border border-border/70 shadow-2xl">
            {regularCards[0]}
          </div>
        </div>
      );
    }

    return (
      <div
        className={cn(
          'grid h-full gap-3 p-3 pb-28 md:gap-4 md:p-4 md:pb-32',
          className
        )}
        style={{
          gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
        }}
      >
        {regularCards}
      </div>
    );
  }
);

export { VoiceGrid };
