import { memo, useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
	ScreenAudioMode,
	type TDesktopAppAudioTargetsResult,
	type TDesktopCapabilities,
	type TDesktopScreenShareSelection,
	type TDesktopShareSource,
} from '@/runtime/types';
import type { TDialogBaseProps } from '../types';
import { resolveAppAudioTargetBehavior } from './resolve-app-audio-target';

type TScreenSharePickerDialogProps = TDialogBaseProps & {
	sources: TDesktopShareSource[];
	capabilities: TDesktopCapabilities;
	defaultAudioMode: ScreenAudioMode;
	onConfirm?: (selection: TDesktopScreenShareSelection) => void;
	onCancel?: () => void;
};

const supportLabelMap = {
	supported: 'Supported',
	'best-effort': 'Best effort',
	unsupported: 'Unavailable',
} as const;

const issueAlertClassNameBySeverity = {
	info: 'border-blue-200/70 bg-blue-500/10 text-blue-100',
	warning: 'border-amber-300/40 bg-amber-500/10 text-amber-100',
	error: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

const ScreenSharePickerDialog = memo(
	({ isOpen, sources, capabilities, defaultAudioMode, onConfirm, onCancel }: TScreenSharePickerDialogProps) => {
		const desktopBridge = getDesktopBridge();
		const [liveCapabilities, setLiveCapabilities] = useState(() => normalizeDesktopCapabilities(capabilities));
		const [selectedSourceId, setSelectedSourceId] = useState(sources[0]?.id);
		const [audioMode, setAudioMode] = useState(defaultAudioMode);
		const [appAudioTargetsResult, setAppAudioTargetsResult] = useState<TDesktopAppAudioTargetsResult>({
			targets: [],
		});
		const [selectedAppAudioTargetId, setSelectedAppAudioTargetId] = useState<string | undefined>(undefined);
		const [loadingAppAudioTargets, setLoadingAppAudioTargets] = useState(false);

		const hasSources = sources.length > 0;
		const displaySources = useMemo(() => sources.filter((source) => source.kind === 'screen'), [sources]);
		const windowSources = useMemo(() => sources.filter((source) => source.kind === 'window'), [sources]);
		const selectedSource = useMemo(() => {
			if (!selectedSourceId) {
				return undefined;
			}

			return sources.find((source) => source.id === selectedSourceId);
		}, [selectedSourceId, sources]);
		const appAudioTargetBehavior = resolveAppAudioTargetBehavior({
			audioMode,
			perAppAudioSupported: liveCapabilities.perAppAudio !== 'unsupported',
			sourceKind: selectedSource?.kind,
			availableTargetCount: appAudioTargetsResult.targets.length,
			suggestedTargetId: appAudioTargetsResult.suggestedTargetId,
			requiresManualSelection: appAudioTargetsResult.requiresManualSelection,
		});
		const screenShareIssues = useMemo(() => {
			return liveCapabilities.issues.filter((issue) => {
				return (
					issue.affects.includes('screen-share') ||
					issue.affects.includes('system-audio') ||
					issue.affects.includes('per-app-audio')
				);
			});
		}, [liveCapabilities.issues]);
		const shouldResolveAppAudioTargets = isOpen && appAudioTargetBehavior.shouldResolveAppAudioTargets;
		const requiresManualAppAudioTarget =
			shouldResolveAppAudioTargets && appAudioTargetBehavior.requiresManualAppAudioTarget;
		const resolvedAppAudioTargetId = requiresManualAppAudioTarget
			? selectedAppAudioTargetId
			: appAudioTargetsResult.suggestedTargetId;
		const allowsImplicitFallbackWithoutTarget =
			shouldResolveAppAudioTargets && appAudioTargetBehavior.allowsImplicitFallbackWithoutTarget;
		const canConfirmShare =
			hasSources &&
			!!selectedSourceId &&
			(!shouldResolveAppAudioTargets || !!resolvedAppAudioTargetId || allowsImplicitFallbackWithoutTarget);
		const fallbackWithoutTargetMessage = useMemo(() => {
			if (!allowsImplicitFallbackWithoutTarget) {
				return undefined;
			}

			if (liveCapabilities.systemAudio === 'unsupported') {
				return 'No running app audio targets were found. If you continue, Sharkord will share video without audio.';
			}

			return 'No running app audio targets were found. If you continue, Sharkord will fall back to system audio.';
		}, [allowsImplicitFallbackWithoutTarget, liveCapabilities.systemAudio]);

		const sourceLabel = useMemo(() => {
			if (!hasSources) {
				return 'No shareable sources were found.';
			}

			return `${sources.length} source${sources.length === 1 ? '' : 's'} available`;
		}, [hasSources, sources.length]);

		const onSubmit = () => {
			if (!selectedSourceId) {
				return;
			}

			if (shouldResolveAppAudioTargets && !resolvedAppAudioTargetId) {
				return;
			}

			onConfirm?.({
				sourceId: selectedSourceId,
				audioMode,
				appAudioTargetId: resolvedAppAudioTargetId,
			});
		};

		const onCancelClick = () => {
			onCancel?.();
		};

		useEffect(() => {
			setLiveCapabilities(normalizeDesktopCapabilities(capabilities));
		}, [capabilities]);

		useEffect(() => {
			if (!isOpen) {
				return;
			}

			setSelectedSourceId(sources[0]?.id);
			setAudioMode(defaultAudioMode);
			setSelectedAppAudioTargetId(undefined);
			setAppAudioTargetsResult({
				targets: [],
			});
			setLoadingAppAudioTargets(false);
		}, [isOpen, sources, defaultAudioMode]);

		useEffect(() => {
			if (!isOpen || !desktopBridge) {
				return;
			}

			return desktopBridge.subscribeCapabilities((nextCapabilities) => {
				setLiveCapabilities(normalizeDesktopCapabilities(nextCapabilities));
			});
		}, [desktopBridge, isOpen]);

		useEffect(() => {
			if (!shouldResolveAppAudioTargets || !selectedSourceId) {
				setLoadingAppAudioTargets(false);
				setAppAudioTargetsResult({
					targets: [],
				});
				setSelectedAppAudioTargetId(undefined);
				return;
			}
			if (!desktopBridge) {
				setAppAudioTargetsResult({
					targets: [],
					warning: 'Desktop bridge is unavailable for per-app audio.',
				});
				setSelectedAppAudioTargetId(undefined);
				return;
			}

			let cancelled = false;
			setLoadingAppAudioTargets(true);

			void desktopBridge
				.listAppAudioTargets(selectedSourceId)
				.then((result) => {
					if (cancelled) {
						return;
					}

					setAppAudioTargetsResult(result);
					const nextTargetBehavior = resolveAppAudioTargetBehavior({
						audioMode,
						perAppAudioSupported: liveCapabilities.perAppAudio !== 'unsupported',
						sourceKind: selectedSource?.kind,
						availableTargetCount: result.targets.length,
						suggestedTargetId: result.suggestedTargetId,
						requiresManualSelection: result.requiresManualSelection,
					});

					setSelectedAppAudioTargetId((currentTargetId) => {
						if (currentTargetId && result.targets.some((target) => target.id === currentTargetId)) {
							return currentTargetId;
						}

						if (nextTargetBehavior.shouldAutoSelectSuggestedTarget) {
							return result.suggestedTargetId;
						}

						return undefined;
					});
				})
				.catch(() => {
					if (cancelled) {
						return;
					}

					setAppAudioTargetsResult({
						targets: [],
						warning: 'Failed to load running app targets.',
					});
					setSelectedAppAudioTargetId(undefined);
				})
				.finally(() => {
					if (!cancelled) {
						setLoadingAppAudioTargets(false);
					}
				});

			return () => {
				cancelled = true;
			};
		}, [
			audioMode,
			desktopBridge,
			liveCapabilities.perAppAudio,
			selectedSource?.kind,
			selectedSourceId,
			shouldResolveAppAudioTargets,
		]);

		return (
			<Dialog open={isOpen}>
				<DialogContent className="max-w-3xl">
					<DialogHeader>
						<DialogTitle>Share Screen</DialogTitle>
						<DialogDescription>{sourceLabel}</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="flex flex-wrap gap-2 text-xs">
							<Badge variant="outline">System Audio: {supportLabelMap[liveCapabilities.systemAudio]}</Badge>
							<Badge variant="outline">Per-App Audio: {supportLabelMap[liveCapabilities.perAppAudio]}</Badge>
							<Badge variant="outline">Platform: {liveCapabilities.platform}</Badge>
						</div>

						{screenShareIssues.length > 0 && (
							<div className="space-y-2">
								{screenShareIssues.map((issue) => (
									<Alert
										key={`${issue.code}:${issue.message}`}
										className={issueAlertClassNameBySeverity[issue.severity]}
									>
										<AlertTitle>{issue.title}</AlertTitle>
										<AlertDescription className="text-current/90">
											<p>{issue.message}</p>
											{issue.guidance.map((guidance) => (
												<p key={guidance}>{guidance}</p>
											))}
										</AlertDescription>
									</Alert>
								))}
							</div>
						)}

						{liveCapabilities.notes.length > 0 && (
							<div className="text-xs text-muted-foreground space-y-1">
								{liveCapabilities.notes.map((note) => (
									<p key={note}>{note}</p>
								))}
							</div>
						)}

						<p className="text-xs text-muted-foreground">
							Fullscreen or exclusive apps may only be shareable by selecting a display.
						</p>

						<div>
							<label className="text-sm font-medium">Audio mode</label>
							<Select value={audioMode} onValueChange={(value) => setAudioMode(value as ScreenAudioMode)}>
								<SelectTrigger className="mt-2 w-56">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectItem value={ScreenAudioMode.SYSTEM}>System audio</SelectItem>
										<SelectItem value={ScreenAudioMode.APP}>Per-app audio</SelectItem>
										<SelectItem value={ScreenAudioMode.NONE}>No shared audio</SelectItem>
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>

						{shouldResolveAppAudioTargets && (
							<div className="space-y-2">
								<label className="text-sm font-medium">App audio source</label>

								{loadingAppAudioTargets && (
									<p className="text-xs text-muted-foreground">Detecting running applications...</p>
								)}

								{!loadingAppAudioTargets && appAudioTargetsResult.warning && appAudioTargetsResult.warning.trim() && (
									<p className="text-xs text-amber-300">{appAudioTargetsResult.warning}</p>
								)}

								{!loadingAppAudioTargets &&
									appAudioTargetBehavior.shouldAutoSelectSuggestedTarget &&
									appAudioTargetsResult.suggestedTargetId && (
										<p className="text-xs text-muted-foreground">Auto-matched a window owner app for isolated audio.</p>
									)}

								{!loadingAppAudioTargets &&
									requiresManualAppAudioTarget &&
									appAudioTargetsResult.targets.length > 0 &&
									!selectedAppAudioTargetId && (
										<p className="text-xs text-muted-foreground">
											Choose the running application that is producing the audio you want to share.
										</p>
									)}

								{!loadingAppAudioTargets && requiresManualAppAudioTarget && (
									<Select
										value={selectedAppAudioTargetId}
										onValueChange={(value) => setSelectedAppAudioTargetId(value)}
									>
										<SelectTrigger className="w-[340px]">
											<SelectValue placeholder="Select app audio target" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												{appAudioTargetsResult.targets.map((target) => (
													<SelectItem key={target.id} value={target.id}>
														{target.label}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
								)}

								{!loadingAppAudioTargets &&
									requiresManualAppAudioTarget &&
									appAudioTargetsResult.targets.length === 0 && (
										<p className="text-xs text-muted-foreground">
											{fallbackWithoutTargetMessage ?? 'No running app targets were found.'}
										</p>
									)}
							</div>
						)}

						<div className="max-h-[420px] overflow-y-auto pr-1 space-y-4">
							{displaySources.length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Displays</p>
									<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
										{displaySources.map((source) => {
											const isSelected = selectedSourceId === source.id;

											return (
												<button
													type="button"
													key={source.id}
													onClick={() => setSelectedSourceId(source.id)}
													className={cn(
														'text-left rounded-md border transition-colors overflow-hidden',
														isSelected
															? 'border-primary ring-2 ring-primary/30'
															: 'border-border hover:border-primary/40',
													)}
												>
													<img
														src={source.thumbnailDataUrl}
														alt={source.name}
														className="h-36 w-full object-cover bg-muted"
													/>
													<div className="p-3 space-y-1">
														<div className="flex items-center gap-2">
															<span className="font-medium truncate">{source.name}</span>
															<Badge variant="secondary" className="text-[10px]">
																{source.kind}
															</Badge>
														</div>
													</div>
												</button>
											);
										})}
									</div>
								</div>
							)}

							{windowSources.length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Windows</p>
									<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
										{windowSources.map((source) => {
											const isSelected = selectedSourceId === source.id;

											return (
												<button
													type="button"
													key={source.id}
													onClick={() => setSelectedSourceId(source.id)}
													className={cn(
														'text-left rounded-md border transition-colors overflow-hidden',
														isSelected
															? 'border-primary ring-2 ring-primary/30'
															: 'border-border hover:border-primary/40',
													)}
												>
													<img
														src={source.thumbnailDataUrl}
														alt={source.name}
														className="h-36 w-full object-cover bg-muted"
													/>
													<div className="p-3 space-y-1">
														<div className="flex items-center gap-2">
															<span className="font-medium truncate">{source.name}</span>
															<Badge variant="secondary" className="text-[10px]">
																{source.kind}
															</Badge>
														</div>
													</div>
												</button>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</div>

					<DialogFooter className="gap-2">
						<Button variant="outline" onClick={onCancelClick}>
							Cancel
						</Button>
						<Button onClick={onSubmit} disabled={!canConfirmShare}>
							Share
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	},
);

export { ScreenSharePickerDialog };
