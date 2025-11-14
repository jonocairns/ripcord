import { useCallback, useState } from 'react';

enum PinnedCardType {
  USER = 'user',
  SCREEN_SHARE = 'screen-share'
}

type TPinnedCard = {
  id: string;
  type: PinnedCardType;
  userId: number;
};

const usePinnedCard = () => {
  const [pinnedCard, setPinnedCard] = useState<TPinnedCard | null>(null);

  const pinCard = useCallback((card: TPinnedCard) => {
    setPinnedCard(card);
  }, []);

  const unpinCard = useCallback(() => {
    setPinnedCard(null);
  }, []);

  const isPinned = useCallback(
    (cardId: string) => {
      return pinnedCard?.id === cardId;
    },
    [pinnedCard]
  );

  return {
    pinnedCard,
    pinCard,
    unpinCard,
    isPinned
  };
};

export { PinnedCardType, usePinnedCard };
export type { TPinnedCard };
