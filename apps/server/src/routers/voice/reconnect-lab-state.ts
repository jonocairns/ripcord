type TReconnectLabFailCode =
  | 'INTERNAL_SERVER_ERROR'
  | 'UNAUTHORIZED'
  | 'CONFLICT';

type TReconnectLabNextRestoreBehavior = {
  delayMs?: number;
  failCode?: TReconnectLabFailCode;
  failMessage?: string;
  closeWsCode?: number;
  closeWsReason?: string;
};

const nextRestoreBehaviorByUserId = new Map<
  number,
  TReconnectLabNextRestoreBehavior
>();

const setVoiceReconnectLabNextRestoreBehavior = (
  userId: number,
  behavior: TReconnectLabNextRestoreBehavior
) => {
  nextRestoreBehaviorByUserId.set(userId, behavior);
};

const clearVoiceReconnectLabNextRestoreBehavior = (userId: number) => {
  nextRestoreBehaviorByUserId.delete(userId);
};

const consumeVoiceReconnectLabNextRestoreBehavior = (
  userId: number
): TReconnectLabNextRestoreBehavior | undefined => {
  const behavior = nextRestoreBehaviorByUserId.get(userId);

  nextRestoreBehaviorByUserId.delete(userId);

  return behavior;
};

export {
  clearVoiceReconnectLabNextRestoreBehavior,
  consumeVoiceReconnectLabNextRestoreBehavior,
  setVoiceReconnectLabNextRestoreBehavior
};
export type { TReconnectLabFailCode, TReconnectLabNextRestoreBehavior };
