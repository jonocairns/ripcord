import { type TUserPresenceStatus, UserStatus } from '@sharkord/shared';
import { LogOut, Settings } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logoutFromServer } from '@/features/server/actions';
import { updateUser } from '@/features/server/users/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { openServerScreen } from '@/features/server-screens/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { ServerScreen } from '../server-screens/screens';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { UserAvatar } from '../user-avatar';
import { UserPopover } from '../user-popover';
import { OwnVoiceControls } from './own-voice-controls';

type TStatusOption = {
	value: TUserPresenceStatus;
	label: string;
	dotClassName: string;
};

const ONLINE_STATUS_OPTION: TStatusOption = {
	value: UserStatus.ONLINE,
	label: 'Online',
	dotClassName: 'bg-status-online',
};

const STATUS_OPTIONS: TStatusOption[] = [
	ONLINE_STATUS_OPTION,
	{
		value: UserStatus.AWAY,
		label: 'Away',
		dotClassName: 'bg-status-idle',
	},
];

const getPresenceStatus = (status?: UserStatus): TUserPresenceStatus => {
	return status === UserStatus.AWAY ? UserStatus.AWAY : UserStatus.ONLINE;
};

const parsePresenceStatus = (value: string): TUserPresenceStatus | undefined => {
	if (value === UserStatus.ONLINE) {
		return UserStatus.ONLINE;
	}

	if (value === UserStatus.AWAY) {
		return UserStatus.AWAY;
	}

	return undefined;
};

const getStatusOption = (status: TUserPresenceStatus) =>
	STATUS_OPTIONS.find((option) => option.value === status) ?? ONLINE_STATUS_OPTION;

const UserControl = memo(() => {
	const ownPublicUser = useOwnPublicUser();
	const [pendingStatus, setPendingStatus] = useState<TUserPresenceStatus | undefined>();

	const handleSettingsClick = useCallback(() => {
		openServerScreen(ServerScreen.USER_SETTINGS);
	}, []);
	const handleLogoutClick = useCallback(() => {
		void logoutFromServer();
	}, []);
	const handleStatusChange = useCallback(
		async (nextStatus: TUserPresenceStatus) => {
			if (!ownPublicUser || pendingStatus !== undefined) {
				return;
			}

			setPendingStatus(nextStatus);

			try {
				const trpc = getTRPCClient();
				const result = await trpc.users.setStatus.mutate({ status: nextStatus });

				updateUser(ownPublicUser.id, { status: result.status });
			} catch (error) {
				toast.error(getTrpcError(error, 'Failed to update status'));
			} finally {
				setPendingStatus(undefined);
			}
		},
		[ownPublicUser, pendingStatus],
	);

	if (!ownPublicUser) return null;

	const ownPresenceStatus = getPresenceStatus(ownPublicUser.status);
	const visiblePresenceStatus = pendingStatus ?? ownPresenceStatus;
	const visibleStatusOption = getStatusOption(visiblePresenceStatus);

	return (
		<div className="flex h-14 items-center justify-between gap-2 px-3">
			<UserPopover
				userId={ownPublicUser.id}
				actions={
					<IconButton
						icon={LogOut}
						variant="destructive"
						size="default"
						className="h-9 w-9 rounded-md"
						title="Log out"
						onClick={handleLogoutClick}
					/>
				}
			>
				<div className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-0.5">
					<div className="relative flex-shrink-0">
						<UserAvatar userId={ownPublicUser.id} className="h-9 w-9" showUserPopover={false} />
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className={cn(
										'absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-card outline-none ring-offset-card transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60',
										visibleStatusOption.dotClassName,
									)}
									disabled={pendingStatus !== undefined}
									title={`Set status: ${visibleStatusOption.label}`}
									aria-label={`Set status: ${visibleStatusOption.label}`}
									onPointerDown={(event) => event.stopPropagation()}
									onClick={(event) => event.stopPropagation()}
								/>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" side="top" className="w-40">
								<DropdownMenuLabel>Status</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={visiblePresenceStatus}
									onValueChange={(value) => {
										const nextStatus = parsePresenceStatus(value);

										if (!nextStatus || nextStatus === visiblePresenceStatus) {
											return;
										}

										void handleStatusChange(nextStatus);
									}}
								>
									{STATUS_OPTIONS.map((option) => (
										<DropdownMenuRadioItem
											key={option.value}
											value={option.value}
											disabled={pendingStatus !== undefined}
										>
											<span className={cn('h-2.5 w-2.5 rounded-full', option.dotClassName)} />
											{option.label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-medium text-foreground">{ownPublicUser.name}</p>
					</div>
				</div>
			</UserPopover>

			<div className="flex shrink-0 items-center gap-1">
				<OwnVoiceControls />
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 rounded-lg text-muted-foreground transition-colors hover:bg-white/6 hover:text-white"
					onClick={handleSettingsClick}
					title="User Settings"
				>
					<Settings className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
});

export { UserControl };
