type TSocketCloseEvent = Pick<Event, 'currentTarget' | 'target'>;

const ignoredSocketCloseEvents = new WeakSet<EventTarget>();

const getSocketFromCloseEvent = (
  event?: TSocketCloseEvent
): EventTarget | undefined => {
  if (event?.currentTarget) {
    return event.currentTarget;
  }

  if (event?.target) {
    return event.target;
  }

  return undefined;
};

export const markSocketCloseEventIgnored = (
  socket: EventTarget | undefined
) => {
  if (!socket) {
    return;
  }

  ignoredSocketCloseEvents.add(socket);
};

export const shouldIgnoreSocketCloseEvent = (event?: TSocketCloseEvent) => {
  const socket = getSocketFromCloseEvent(event);

  if (!socket || !ignoredSocketCloseEvents.has(socket)) {
    return false;
  }

  ignoredSocketCloseEvents.delete(socket);
  return true;
};
