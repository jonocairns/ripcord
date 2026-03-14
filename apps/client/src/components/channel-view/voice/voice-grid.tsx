import { cn } from '@/lib/utils';
import { isValidElement, memo, useMemo, type ReactNode } from 'react';

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
          <div className="min-h-0 flex-1 pb-3">{pinnedCard}</div>

          {regularCards.length > 0 && (
            <div className="flex-shrink-0 rounded-[1.5rem] border border-border/70 bg-card/45 p-2 shadow-xl backdrop-blur-sm">
              <div className="flex justify-start gap-2.5 overflow-x-auto">
                {regularCards.map((card, index) => (
                  <div
                    key={index}
                    className="h-28 w-44 flex-shrink-0 overflow-hidden rounded-xl"
                  >
                    {card}
                  </div>
                ))}
              </div>
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
          className={cn('flex h-full items-center justify-center', className)}
        >
          <div className="h-full w-full max-w-6xl overflow-hidden rounded-[1.75rem] border border-border/70 shadow-[0_28px_60px_rgb(0_0_0/0.32)]">
            {regularCards[0]}
          </div>
        </div>
      );
    }

    return (
      <div className={cn('h-full', className)}>
        <div
          className="mx-auto grid h-full max-w-7xl gap-3 md:gap-4"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
          }}
        >
          {regularCards}
        </div>
      </div>
    );
  }
);

export { VoiceGrid };
