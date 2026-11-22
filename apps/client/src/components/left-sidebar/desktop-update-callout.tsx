import { Download, RotateCw } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopUpdateStatus } from '@/runtime/types';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { DesktopUpdateNotes } from './desktop-update-notes';

const MANUAL_UPDATE_BASE_URL = 'https://github.com/jonocairns/ripcord/releases';

const resolveManualUpdateUrl = (availableVersion?: string): string => {
	const normalizedVersion = availableVersion?.trim();
	if (!normalizedVersion) {
		return MANUAL_UPDATE_BASE_URL;
	}

	const versionWithoutTagPrefix = normalizedVersion.replace(/^v/i, '');
	if (!versionWithoutTagPrefix) {
		return MANUAL_UPDATE_BASE_URL;
	}

	const releaseTag = normalizedVersion.startsWith('v') ? normalizedVersion : `v${normalizedVersion}`;
	const installerFileName = `Ripcord.Desktop.Setup.${versionWithoutTagPrefix}.exe`;

	return `${MANUAL_UPDATE_BASE_URL}/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(installerFileName)}`;
};

type TCalloutKind = 'ready' | 'manual';

type TCalloutContent = {
	kind: TCalloutKind;
	title: string;
	description: string;
	icon: ReactNode;
	pulseTitle: boolean;
};

const resolveCalloutContent = (status: TDesktopUpdateStatus, canRestart: boolean): TCalloutContent | undefined => {
	const versionLabel = status.availableVersion ? `Version ${status.availableVersion}` : 'The update';

	if (status.state === 'downloaded') {
		return {
			kind: 'ready',
			title: 'Update ready',
			description: canRestart
				? `${versionLabel} installs when you restart or close Ripcord.`
				: `${versionLabel} installs when you close Ripcord.`,
			icon: <RotateCw className="h-4 w-4 text-success" />,
			pulseTitle: false,
		};
	}

	if (status.state === 'available' && status.manualInstallRequired) {
		return {
			kind: 'manual',
			title: 'Update available',
			description: status.availableVersion
				? `Version ${status.availableVersion} is available to download.`
				: 'A new version is available to download.',
			icon: <Download className="h-4 w-4 text-success" />,
			pulseTitle: true,
		};
	}

	return undefined;
};

const DesktopUpdateCallout = memo(() => {
	const desktopBridge = getDesktopBridge();
	const [status, setStatus] = useState<TDesktopUpdateStatus | undefined>();
	const [restarting, setRestarting] = useState(false);
	const restartToUpdate = desktopBridge?.restartToUpdate;

	useEffect(() => {
		if (!desktopBridge) {
			return;
		}

		let disposed = false;

		void desktopBridge
			.getUpdateStatus()
			.then((nextStatus) => {
				if (disposed) {
					return;
				}

				setStatus(nextStatus);
			})
			.catch(() => {
				// ignore transient bootstrap errors
			});

		const unsubscribe = desktopBridge.subscribeUpdateStatus((nextStatus) => {
			if (disposed) {
				return;
			}

			setStatus(nextStatus);
		});

		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [desktopBridge]);

	const calloutContent = useMemo(() => {
		if (!status) {
			return undefined;
		}

		return resolveCalloutContent(status, Boolean(restartToUpdate));
	}, [status, restartToUpdate]);

	const manualInstallUrl = useMemo(() => resolveManualUpdateUrl(status?.availableVersion), [status?.availableVersion]);

	const handleOpenManualInstall = useCallback(() => {
		window.open(manualInstallUrl, '_blank', 'noopener,noreferrer');
	}, [manualInstallUrl]);

	const handleRestart = useCallback(async () => {
		if (!restartToUpdate) {
			return;
		}

		setRestarting(true);
		const restarted = await restartToUpdate().catch(() => false);
		if (!restarted) {
			setRestarting(false);
		}
	}, [restartToUpdate]);

	if (!status || !calloutContent) {
		return null;
	}

	const releaseNotes = status.releaseNotes;

	return (
		<div className="relative border-t border-border px-2 py-2 bg-card">
			<div className="rounded-md p-2 bg-card">
				<div className="flex items-center gap-2">
					{calloutContent.icon}
					<div className="min-w-0">
						<p className={`text-sm font-semibold text-foreground ${calloutContent.pulseTitle ? 'animate-pulse' : ''}`}>
							{calloutContent.title}
						</p>
						<p className="mt-0.5 text-sm text-muted-foreground leading-snug">{calloutContent.description}</p>
					</div>
				</div>

				{calloutContent.kind === 'ready' && restartToUpdate && (
					<Button size="sm" className="mt-2 w-full" disabled={restarting} onClick={() => void handleRestart()}>
						{restarting ? 'Restarting…' : 'Restart to update'}
					</Button>
				)}

				{calloutContent.kind === 'manual' && (
					<Button size="sm" className="mt-2 w-full" onClick={handleOpenManualInstall}>
						{status.availableVersion ? 'Download Installer' : 'Open Releases'}
					</Button>
				)}

				{releaseNotes && releaseNotes.length > 0 && (
					<Popover>
						<PopoverTrigger asChild>
							<Button size="sm" variant="ghost" className="mt-1 w-full text-muted-foreground">
								What&apos;s new
							</Button>
						</PopoverTrigger>
						<PopoverContent side="right" align="end" className="w-96">
							<DesktopUpdateNotes notes={releaseNotes} availableVersion={status.availableVersion} />
						</PopoverContent>
					</Popover>
				)}
			</div>
		</div>
	);
});

export { DesktopUpdateCallout };
