import { Permission } from '@sharkord/shared';
import { memo, useCallback, useState } from 'react';
import { LeftSidebar } from '@/components/left-sidebar';
import { ModViewSheet } from '@/components/mod-view-sheet';
import { Protect } from '@/components/protect';
import { RightSidebar } from '@/components/right-sidebar';
import { VoiceChatSidebar } from '@/components/voice-chat-sidebar';
import { VoiceProvider } from '@/components/voice-provider';
import { getLocalStorageItem, LocalStorageKey, setLocalStorageItem } from '@/helpers/storage';
import { useIdleAwayChecker } from '@/hooks/use-idle-away-checker';
import { useSwipeGestures } from '@/hooks/use-swipe-gestures';
import { cn } from '@/lib/utils';
import { ContentWrapper } from './content-wrapper';
import { PreventBrowser } from './prevent-browser';

const ServerView = memo(() => {
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const [isMobileUsersOpen, setIsMobileUsersOpen] = useState(false);
	const [isMembersSidebarCollapsed, setIsMembersSidebarCollapsed] = useState(
		() => getLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_COLLAPSED) === 'true',
	);
	const isVoiceChatSidebarOpen = false;

	useIdleAwayChecker();

	const handleSwipeRight = useCallback(() => {
		if (isMobileMenuOpen || isMobileUsersOpen) {
			setIsMobileMenuOpen(false);
			setIsMobileUsersOpen(false);
			return;
		}

		setIsMobileMenuOpen(true);
	}, [isMobileMenuOpen, isMobileUsersOpen]);

	const handleSwipeLeft = useCallback(() => {
		if (isMobileMenuOpen || isMobileUsersOpen) {
			setIsMobileMenuOpen(false);
			setIsMobileUsersOpen(false);

			return;
		}

		setIsMobileUsersOpen(true);
	}, [isMobileMenuOpen, isMobileUsersOpen]);

	const swipeHandlers = useSwipeGestures({
		onSwipeRight: handleSwipeRight,
		onSwipeLeft: handleSwipeLeft,
	});
	const handleToggleMembersSidebarCollapse = useCallback(() => {
		setIsMembersSidebarCollapsed((prev) => {
			const next = !prev;
			setLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_COLLAPSED, String(next));
			return next;
		});
	}, []);

	return (
		<VoiceProvider>
			<div className="flex min-h-0 flex-1 flex-col bg-background text-foreground dark" {...swipeHandlers}>
				<div className="relative flex min-h-0 flex-1 overflow-hidden">
					<PreventBrowser />

					{isMobileMenuOpen && (
						<div
							className="md:hidden fixed inset-0 cursor-pointer bg-black/50 z-30"
							onClick={() => setIsMobileMenuOpen(false)}
						/>
					)}

					{isMobileUsersOpen && (
						<div
							className="lg:hidden fixed inset-0 cursor-pointer bg-black/50 z-30"
							onClick={() => setIsMobileUsersOpen(false)}
						/>
					)}

					<LeftSidebar
						className={cn(
							'fixed inset-0 left-0 h-full z-40 transition-transform duration-300 ease-in-out md:relative md:inset-auto md:left-auto md:z-0 md:flex md:h-auto',
							isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
						)}
					/>

					<ContentWrapper />

					<VoiceChatSidebar isOpen={isVoiceChatSidebarOpen} />

					<RightSidebar
						className={cn(
							'fixed top-0 right-0 bottom-0 h-full z-40 transition-all duration-500 ease-in-out',
							'lg:relative lg:top-auto lg:right-auto lg:bottom-auto lg:z-0 lg:h-auto',
							isMobileUsersOpen ? 'translate-x-0 lg:translate-x-0' : 'translate-x-full lg:translate-x-0',
						)}
						isOpen
						isCollapsed={isMembersSidebarCollapsed}
						onToggleCollapse={handleToggleMembersSidebarCollapse}
					/>

					<Protect permission={Permission.MANAGE_USERS}>
						<ModViewSheet />
					</Protect>
				</div>
			</div>
		</VoiceProvider>
	);
});

export { ServerView };
