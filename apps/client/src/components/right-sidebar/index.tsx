import { PanelRight, PanelRightClose } from 'lucide-react';
import { memo, useMemo } from 'react';
import { UserAvatar } from '@/components/user-avatar';
import { useUsers } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { UserPopover } from '../user-popover';

const MAX_USERS_TO_SHOW = 100;

type TMember = {
	id: number;
	name: string;
	banned: boolean;
};

type TUserProps = {
	user: TMember;
	isCollapsed?: boolean;
};

const User = memo(({ user, isCollapsed = false }: TUserProps) => {
	return (
		<UserPopover userId={user.id}>
			<div
				className={cn(
					'flex cursor-pointer select-none items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent/65',
					isCollapsed && 'lg:justify-center lg:gap-0 lg:px-1 lg:py-1',
				)}
				title={user.name}
			>
				<UserAvatar userId={user.id} className="h-8 w-8" />
				<div
					className={cn(
						'min-w-0 overflow-hidden lg:max-w-[10rem] lg:opacity-100 lg:transition-[max-width,opacity] lg:duration-200 lg:ease-out',
						isCollapsed && 'lg:max-w-0 lg:opacity-0',
					)}
				>
					<span
						className={cn(
							'block truncate text-sm font-medium text-foreground',
							user.banned && 'line-through text-muted-foreground',
						)}
					>
						{user.name}
					</span>
				</div>
			</div>
		</UserPopover>
	);
});

type TRightSidebarProps = {
	className?: string;
	isOpen?: boolean;
	isCollapsed?: boolean;
	onToggleCollapse?: () => void;
};

const RightSidebar = memo(({ className, isOpen = true, isCollapsed = false, onToggleCollapse }: TRightSidebarProps) => {
	const users = useUsers();

	const usersToShow = useMemo(() => users.slice(0, MAX_USERS_TO_SHOW) as TMember[], [users]);
	const visibleUsers = useMemo(() => usersToShow.filter((user) => !user.banned), [usersToShow]);
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
								{visibleUsers.length > 0 && (
									<div className="space-y-1">
										{visibleUsers.map((user) => (
											<User key={user.id} user={user} />
										))}
									</div>
								)}
								{bannedUsers.length > 0 && (
									<section className="space-y-1">
										<div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
											Banned ({bannedUsers.length})
										</div>
										<div className="space-y-1">
											{bannedUsers.map((user) => (
												<User key={user.id} user={user} />
											))}
										</div>
									</section>
								)}
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
