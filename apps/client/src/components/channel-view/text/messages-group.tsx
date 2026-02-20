import { RelativeTime } from '@/components/relative-time';
import { UserAvatar } from '@/components/user-avatar';
import { useIsOwnUser, useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import type { TJoinedMessage } from '@sharkord/shared';
import { format } from 'date-fns';
import { memo, useState } from 'react';
import { Message } from './message';

type TMessagesGroupProps = {
  group: TJoinedMessage[];
};

const MessagesGroup = memo(({ group }: TMessagesGroupProps) => {
  const firstMessage = group[0];
  const otherMessages = group.slice(1);
  const isSingleMessageGroup = group.length === 1;
  const user = useUserById(firstMessage.userId);
  const date = new Date(firstMessage.createdAt);
  const isOwnUser = useIsOwnUser(firstMessage.userId);
  const [hoveredMessageId, setHoveredMessageId] = useState<number | undefined>(
    undefined
  );
  const isFirstMessageHovered = hoveredMessageId === firstMessage.id;

  if (!user) return null;

  return (
    <div
      className="min-w-0 max-w-dvw"
      onMouseLeave={() => setHoveredMessageId(undefined)}
    >
      <div
        className={cn(
          'relative flex min-w-0 gap-2 rounded-lg px-2 transition-colors',
          isSingleMessageGroup ? 'py-2.5' : 'pt-2.5 pb-0',
          isSingleMessageGroup && isFirstMessageHovered && 'bg-secondary/45'
        )}
        onMouseEnter={
          isSingleMessageGroup
            ? () => setHoveredMessageId(firstMessage.id)
            : undefined
        }
      >
        <div
          onMouseEnter={
            isSingleMessageGroup
              ? () => setHoveredMessageId(firstMessage.id)
              : undefined
          }
        >
          <UserAvatar userId={user.id} className="h-10 w-10" showUserPopover />
        </div>
        <div className="flex min-w-0 w-full flex-col">
          <div
            className="flex select-none items-baseline gap-2"
            onMouseEnter={
              isSingleMessageGroup
                ? () => setHoveredMessageId(firstMessage.id)
                : undefined
            }
          >
            <span className={cn(isOwnUser && 'font-bold')}>{user.name}</span>
            <RelativeTime date={date}>
              {(relativeTime) => (
                <span
                  className="text-primary/60 text-xs"
                  title={format(date, 'PPpp')}
                >
                  {relativeTime}
                </span>
              )}
            </RelativeTime>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-col">
            <Message
              message={firstMessage}
              actionsVisible={isFirstMessageHovered}
              onHover={() => setHoveredMessageId(firstMessage.id)}
              anchorToGroup={isSingleMessageGroup}
            />
          </div>
        </div>
      </div>

      {otherMessages.length > 0 && (
        <div className="ml-12 flex min-w-0 flex-col px-2">
          {otherMessages.map((message) => (
            <Message
              key={message.id}
              message={message}
              actionsVisible={hoveredMessageId === message.id}
              onHover={() => setHoveredMessageId(message.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export { MessagesGroup };
