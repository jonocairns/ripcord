import { UserStatus } from '@sharkord/shared';
import { memo } from 'react';
import { useUserById } from '@/features/server/users/hooks';
import { getAvatarColor } from '@/helpers/get-avatar-color';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

type TUserAvatarProps = {
	userId: number;
	className?: string;
	fallbackClassName?: string;
	showUserPopover?: boolean;
	showStatusBadge?: boolean;
	onClick?: () => void;
};

const UserAvatar = memo(
	({
		userId,
		className,
		fallbackClassName,
		showUserPopover = false,
		showStatusBadge = true,
		onClick,
	}: TUserAvatarProps) => {
		const user = useUserById(userId);

		if (!user) return null;

		const content = (
			<div className={cn('relative h-fit w-fit', onClick && 'cursor-pointer')} onClick={onClick}>
				<Avatar className={cn('h-8 w-8', className)}>
					<AvatarImage src={getFileUrl(user.avatar)} key={user.avatarId} />
					<AvatarFallback
						className={cn('text-xs font-semibold leading-none text-white', getAvatarColor(userId), fallbackClassName)}
					>
						{getInitialsFromName(user.name)}
					</AvatarFallback>
				</Avatar>
				{showStatusBadge && (
					<UserStatusBadge status={user.status || UserStatus.OFFLINE} className="absolute bottom-0 right-0" />
				)}
			</div>
		);

		if (!showUserPopover) return content;

		return <UserPopover userId={userId}>{content}</UserPopover>;
	},
);

export { UserAvatar };
