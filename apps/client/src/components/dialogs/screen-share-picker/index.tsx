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
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import type {
	ScreenAudioMode,
	TDesktopAppAudioTargetsResult,
	TDesktopCapabilities,
	TDesktopScreenShareSelection,
	TDesktopShareSource,
} from '@/runtime/types';
import type { TDialogBaseProps } from '../types';
import {
	getDefaultScreenShareIncludeAudio,
	getEffectiveScreenShareAudioMode,
	resolveAppAudioTargetBehavior,
} from './resolve-app-audio-target';

type TScreenSharePickerDialogProps = TDialogBaseProps & {
	sources: TDesktopShareSource[];
	capabilities?: TDesktopCapabilities;
	isLoading?: boolean;
	defaultAudioMode: ScreenAudioMode;
	onConfirm?: (selection: TDesktopScreenShareSelection) => void;
	onCancel?: () => void;
};

const issueAlertClassNameBySeverity = {
	info: 'border-blue-200/70 bg-blue-500/10 text-blue-100',
	warning: 'border-amber-300/40 bg-amber-500/10 text-amber-100',
	error: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

const LOADING_PLACEHOLDER_CAPABILITIES: TDesktopCapabilities = {
	platform: 'windows',
	systemAudio: 'unsupported',
	perAppAudio: 'unsupported',
	globalPushKeybinds: 'unsupported',
	issues: [],
	notes: [],
};

const ScreenSharePickerDialog = memo(
	({
		isOpen,
		sources,
		capabilities,
		isLoading = false,
		defaultAudioMode,
		onConfirm,
		onCancel,
	}: TScreenSharePickerDialogProps) => {
		const desktopBridge = getDesktopBridge();
		const [liveCapabilities, setLiveCapabilities] = useState(() =>
			normalizeDesktopCapabilities(capabilities ?? LOADING_PLACEHOLDER_CAPABILITIES),
		);
		const [selectedSourceId, setSelectedSourceId] = useState(sources[0]?.id);
		const [includeAudioRequested, setIncludeAudioRequested] = useState(() =>
			getDefaultScreenShareIncludeAudio(defaultAudioMode),
		);
		const [appAudioTargetsResult, setAppAudioTargetsResult] = useState<TDesktopAppAudioTargetsResult>({
			targets: [],
		});
		const [selectedAppAudioTargetId, setSelectedAppAudioTargetId] = useState<string | undefined>(undefined);
		const [loadingAppAudioTargets, setLoadingAppAudioTargets] = useState(false);

		const hasSources = sources.length > 0;
		const showLoadingBody = isLoading && !hasSources;
		const displaySources = useMemo(() => sources.filter((source) => source.kind === 'screen'), [sources]);
		const windowSources = useMemo(() => sources.filter((source) => source.kind === 'window'), [sources]);
		const selectedSource = useMemo(() => {
			if (!selectedSourceId) {
				return undefined;
			}

			return sources.find((source) => source.id === selectedSourceId);
		}, [selectedSourceId, sources]);
		const systemAudioSupported = liveCapabilities.systemAudio !== 'unsupported';
		const perAppAudioSupported = liveCapabilities.perAppAudio !== 'unsupported';
		const canIncludeAudio = (() => {
			if (selectedSource?.kind === 'screen') {
				return systemAudioSupported;
			}

			if (selectedSource?.kind === 'window') {
				return perAppAudioSupported || systemAudioSupported;
			}

			return false;
		})();
		const includeAudio = canIncludeAudio && includeAudioRequested;
		const effectiveAudioMode = getEffectiveScreenShareAudioMode({
			includeAudio,
			systemAudioSupported,
			perAppAudioSupported,
			sourceKind: selectedSource?.kind,
		});
		const appAudioTargetBehavior = resolveAppAudioTargetBehavior({
			audioMode: effectiveAudioMode,
			perAppAudioSupported,
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
		const isResolvingAppAudioTargets = shouldResolveAppAudioTargets && loadingAppAudioTargets;
		const requiresManualAppAudioTarget =
			shouldResolveAppAudioTargets && appAudioTargetBehavior.requiresManualAppAudioTarget;
		const resolvedAppAudioTargetId = requiresManualAppAudioTarget
			? selectedAppAudioTargetId
			: appAudioTargetsResult.suggestedTargetId;
		const allowsImplicitFallbackWithoutTarget =
			shouldResolveAppAudioTargets && appAudioTargetBehavior.allowsImplicitFallbackWithoutTarget;
		const canConfirmShare =
			!showLoadingBody &&
			hasSources &&
			!!selectedSourceId &&
			!isResolvingAppAudioTargets &&
			(!shouldResolveAppAudioTargets || !!resolvedAppAudioTargetId || allowsImplicitFallbackWithoutTarget);
		const fallbackWithoutTargetMessage = useMemo(() => {
			if (!allowsImplicitFallbackWithoutTarget) {
				return undefined;
			}

			if (liveCapabilities.systemAudio === 'unsupported') {
				return 'No running app audio targets were found. If you continue, screen share will continue without audio.';
			}

			return 'No running app audio targets were found. If you continue, screen share will fall back to system audio.';
		}, [allowsImplicitFallbackWithoutTarget, liveCapabilities.systemAudio]);

		const sourceLabel = useMemo(() => {
			if (showLoadingBody) {
				return 'Finding windows and screens you can share...';
			}

			if (!hasSources) {
				return 'No shareable sources were found.';
			}

			return `${sources.length} source${sources.length === 1 ? '' : 's'} available`;
		}, [hasSources, showLoadingBody, sources.length]);

		const onSubmit = () => {
			if (!selectedSourceId) {
				return;
			}

			if (isResolvingAppAudioTargets) {
				return;
			}

			if (shouldResolveAppAudioTargets && !resolvedAppAudioTargetId && !allowsImplicitFallbackWithoutTarget) {
				return;
			}

			onConfirm?.({
				sourceId: selectedSourceId,
				audioMode: effectiveAudioMode,
				appAudioTargetId: resolvedAppAudioTargetId,
			});
		};

		const onCancelClick = () => {
			onCancel?.();
		};

		useEffect(() => {
			if (!capabilities) return;
			setLiveCapabilities(normalizeDesktopCapabilities(capabilities));
		}, [capabilities]);

		useEffect(() => {
			if (!isOpen) {
				return;
			}

			setSelectedSourceId(sources[0]?.id);
			setIncludeAudioRequested(getDefaultScreenShareIncludeAudio(defaultAudioMode));
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
						audioMode: effectiveAudioMode,
						perAppAudioSupported,
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
			desktopBridge,
			effectiveAudioMode,
			perAppAudioSupported,
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

						<div className="max-h-[420px] overflow-y-auto pr-1 space-y-4">
							{showLoadingBody && (
								<div className="flex min-h-[240px] items-center justify-center">
									<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
										<div
											className="size-8 rounded-full border-2 border-muted-foreground/20 border-t-primary animate-spin"
											aria-hidden
										/>
										<p className="text-sm">Loading shareable windows and screens...</p>
									</div>
								</div>
							)}

							{!showLoadingBody && displaySources.length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Displays</p>
									<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
										{displaySources.map((source) => {
											const isSelected = selectedSourceId === source.id;

											return (
												<button
													type="button"
													key={source.id}
													onClick={() => setSelectedSourceId(source.id)}
													className={cn(
														'overflow-hidden rounded-md border text-left transition-colors',
														isSelected
															? 'border-primary ring-2 ring-primary/30'
															: 'border-border hover:border-primary/40',
													)}
												>
													<img
														src={source.thumbnailDataUrl}
														alt={source.name}
														className="h-36 w-full bg-muted object-cover"
													/>
													<div className="space-y-1 p-3">
														<div className="flex items-center gap-2">
															<span className="truncate font-medium">{source.name}</span>
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

							{!showLoadingBody && windowSources.length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Windows</p>
									<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
										{windowSources.map((source) => {
											const isSelected = selectedSourceId === source.id;

											return (
												<button
													type="button"
													key={source.id}
													onClick={() => setSelectedSourceId(source.id)}
													className={cn(
														'overflow-hidden rounded-md border text-left transition-colors',
														isSelected
															? 'border-primary ring-2 ring-primary/30'
															: 'border-border hover:border-primary/40',
													)}
												>
													<img
														src={source.thumbnailDataUrl}
														alt={source.name}
														className="h-36 w-full bg-muted object-cover"
													/>
													<div className="space-y-1 p-3">
														<div className="flex items-center gap-2">
															<span className="truncate font-medium">{source.name}</span>
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

						{!showLoadingBody && shouldResolveAppAudioTargets && (
							<div className="space-y-2 border-t border-border/60 pt-4">
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
					</div>

					<DialogFooter className="w-full flex-row items-center gap-4 sm:justify-between">
						<div className="shrink-0 flex items-center gap-3">
							<p className="text-sm font-medium">Include audio</p>
							<Switch checked={includeAudio} onCheckedChange={setIncludeAudioRequested} disabled={!canIncludeAudio} />
						</div>

						<div className="ml-auto flex items-center gap-2">
							<Button variant="outline" onClick={onCancelClick}>
								Cancel
							</Button>
							<Button onClick={onSubmit} disabled={!canConfirmShare}>
								Share
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	},
);

export { ScreenSharePickerDialog };
