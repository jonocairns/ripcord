import { UserStatus } from '@sharkord/shared';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { memo, useMemo } from 'react';
import { UserAvatar } from '@/components/user-avatar';
import { useUsers } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { UserPopover } from '../user-popover';

const MAX_USERS_TO_SHOW = 100;

const isPresentStatus = (status?: UserStatus) =>
	status === UserStatus.ONLINE || status === UserStatus.AWAY || status === UserStatus.IDLE;

const getStatusLabel = (status?: UserStatus) => {
	switch (status) {
		case UserStatus.AWAY:
			return 'Away';
		case UserStatus.IDLE:
			return 'Idle';
		case UserStatus.ONLINE:
			return 'Online';
		default:
			return 'Offline';
	}
};

const getStatusDotClassName = (status?: UserStatus) => {
	switch (status) {
		case UserStatus.AWAY:
		case UserStatus.IDLE:
			return 'bg-amber-400';
		case UserStatus.ONLINE:
			return 'bg-[#3ba55d]';
		default:
			return 'bg-muted-foreground/60';
	}
};

type TMember = {
	id: number;
	name: string;
	banned: boolean;
	status?: UserStatus;
};

type TUserProps = {
	user: TMember;
	isCollapsed?: boolean;
};

const User = memo(({ user, isCollapsed = false }: TUserProps) => {
	const isPresent = isPresentStatus(user.status);

	return (
		<UserPopover userId={user.id}>
			<div
				className={cn(
					'flex cursor-pointer select-none items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent/65',
					isCollapsed && 'lg:justify-center lg:gap-0 lg:px-1 lg:py-1',
				)}
				title={`${user.name} (${getStatusLabel(user.status)})`}
			>
				<div className="relative">
					<UserAvatar userId={user.id} className={cn('h-8 w-8', !isPresent && 'opacity-60')} />
					<span
						aria-hidden
						className={cn(
							'absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-card',
							getStatusDotClassName(user.status),
						)}
					/>
				</div>
				<div
					className={cn(
						'min-w-0 overflow-hidden lg:max-w-[10rem] lg:opacity-100 lg:transition-[max-width,opacity] lg:duration-200 lg:ease-out',
						isCollapsed && 'lg:max-w-0 lg:opacity-0',
					)}
				>
					<span
						className={cn(
							'block truncate text-sm font-medium',
							isPresent ? 'text-foreground' : 'text-muted-foreground',
							user.banned && 'line-through',
						)}
					>
						{user.name}
					</span>
				</div>
			</div>
		</UserPopover>
	);
});

type TSectionProps = {
	title: string;
	users: TMember[];
};

const Section = memo(({ title, users }: TSectionProps) => (
	<section className="space-y-1">
		<div className="px-2 text-[11px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
			{title} ({users.length})
		</div>
		<div className="space-y-1">
			{users.map((user) => (
				<User key={user.id} user={user} />
			))}
		</div>
	</section>
));

type TRightSidebarProps = {
	className?: string;
	isOpen?: boolean;
	isCollapsed?: boolean;
	onToggleCollapse?: () => void;
};

const RightSidebar = memo(({ className, isOpen = true, isCollapsed = false, onToggleCollapse }: TRightSidebarProps) => {
	const users = useUsers();

	const usersToShow = useMemo<TMember[]>(() => users.slice(0, MAX_USERS_TO_SHOW), [users]);
	const onlineUsers = useMemo(
		() => usersToShow.filter((user) => !user.banned && isPresentStatus(user.status)),
		[usersToShow],
	);
	const offlineUsers = useMemo(
		() => usersToShow.filter((user) => !user.banned && !isPresentStatus(user.status)),
		[usersToShow],
	);
	const bannedUsers = useMemo(() => usersToShow.filter((user) => user.banned), [usersToShow]);

	const hasHiddenUsers = users.length > MAX_USERS_TO_SHOW;

	return (
		<aside
			className={cn(
				'flex h-full flex-col border-l border-border/70 bg-card/85 backdrop-blur-sm transition-all duration-500 ease-in-out',
				isOpen && isCollapsed ? 'w-60 lg:w-16' : isOpen ? 'w-60' : 'w-0 border-l-0',
				className,
			)}
			style={{ overflow: 'hidden' }}
		>
			{isOpen && (
				<>
					<div
						className={cn(
							'flex h-12 items-center justify-between border-b border-border/70 px-3',
							isCollapsed && 'lg:px-0 lg:justify-center',
						)}
					>
						<div
							className={cn(
								'flex items-center gap-2 overflow-hidden whitespace-nowrap text-sm font-semibold text-foreground lg:max-w-36 lg:opacity-100 lg:transition-[max-width,opacity] lg:duration-200 lg:ease-out',
								isCollapsed && 'lg:max-w-0 lg:opacity-0',
							)}
						>
							<span>Members</span>
							<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
								{users.length}
							</span>
						</div>
						{onToggleCollapse && (
							<Button
								variant="ghost"
								size="icon-sm"
								className={cn('hidden lg:inline-flex', isCollapsed && 'lg:mx-auto')}
								onClick={onToggleCollapse}
							>
								{isCollapsed ? <PanelRight className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
							</Button>
						)}
					</div>

					<div className={cn('flex-1 overflow-y-auto p-2', isCollapsed && 'lg:p-1')}>
						{isCollapsed ? (
							<div className="space-y-2 lg:flex lg:flex-col lg:items-center">
								{usersToShow.map((user) => (
									<User key={user.id} user={user} isCollapsed />
								))}
							</div>
						) : (
							<div className="space-y-4">
								{onlineUsers.length > 0 && <Section title="Online" users={onlineUsers} />}
								{offlineUsers.length > 0 && <Section title="Offline" users={offlineUsers} />}
								{bannedUsers.length > 0 && <Section title="Banned" users={bannedUsers} />}
							</div>
						)}

						{hasHiddenUsers && (
							<div className={cn('px-2 py-2 text-xs text-muted-foreground', isCollapsed && 'lg:hidden')}>
								More members...
							</div>
						)}
					</div>
				</>
			)}
		</aside>
	);
});

export { RightSidebar };
