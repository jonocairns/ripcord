import { useCan } from '@/features/server/hooks';
import { useIsOwnUser } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { Permission, type TJoinedMessage } from '@sharkord/shared';
import { memo, useMemo, useState } from 'react';
import { MessageActions } from './message-actions';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';

type TMessageProps = {
  message: TJoinedMessage;
  actionsVisible: boolean;
  onHover: () => void;
  anchorToGroup?: boolean;
};

const Message = memo(
  ({ message, actionsVisible, onHover, anchorToGroup }: TMessageProps) => {
    const [isEditing, setIsEditing] = useState(false);
    const isFromOwnUser = useIsOwnUser(message.userId);
    const can = useCan();

    const canManage = useMemo(
      () => can(Permission.MANAGE_MESSAGES) || isFromOwnUser,
      [can, isFromOwnUser]
    );

    return (
      <div
        className={cn(
          'min-w-0 flex-1 rounded-md px-2 py-1 transition-colors',
          !anchorToGroup && actionsVisible && 'bg-secondary/45',
          !anchorToGroup && 'hover:bg-secondary/45',
          !anchorToGroup && 'relative'
        )}
        onMouseEnter={onHover}
      >
        {!isEditing ? (
          <>
            <MessageRenderer message={message} />
            <MessageActions
              visible={actionsVisible}
              anchorToGroup={anchorToGroup}
              onEdit={() => setIsEditing(true)}
              canManage={canManage}
              messageId={message.id}
              editable={message.editable ?? false}
            />
          </>
        ) : (
          <MessageEditInline
            message={message}
            onBlur={() => setIsEditing(false)}
          />
        )}
      </div>
    );
  }
);

export { Message };
