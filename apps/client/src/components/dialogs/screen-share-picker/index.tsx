import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
  ScreenAudioMode,
  type TDesktopAppAudioTargetsResult,
  type TDesktopCapabilities,
  type TDesktopScreenShareSelection,
  type TDesktopShareSource
} from '@/runtime/types';
import { memo, useEffect, useMemo, useState } from 'react';
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
  unsupported: 'Unavailable'
} as const;

const ScreenSharePickerDialog = memo(
  ({
    isOpen,
    sources,
    capabilities,
    defaultAudioMode,
    onConfirm,
    onCancel
  }: TScreenSharePickerDialogProps) => {
    const [selectedSourceId, setSelectedSourceId] = useState(sources[0]?.id);
    const [audioMode, setAudioMode] = useState(defaultAudioMode);
    const [appAudioTargetsResult, setAppAudioTargetsResult] =
      useState<TDesktopAppAudioTargetsResult>({
        targets: []
      });
    const [selectedAppAudioTargetId, setSelectedAppAudioTargetId] = useState<
      string | undefined
    >(undefined);
    const [loadingAppAudioTargets, setLoadingAppAudioTargets] = useState(false);

    const hasSources = sources.length > 0;
    const displaySources = useMemo(
      () => sources.filter((source) => source.kind === 'screen'),
      [sources]
    );
    const windowSources = useMemo(
      () => sources.filter((source) => source.kind === 'window'),
      [sources]
    );
    const selectedSource = useMemo(() => {
      if (!selectedSourceId) {
        return undefined;
      }

      return sources.find((source) => source.id === selectedSourceId);
    }, [selectedSourceId, sources]);
    const appAudioTargetBehavior = resolveAppAudioTargetBehavior({
      audioMode,
      perAppAudioSupported: capabilities.perAppAudio === 'supported',
      sourceKind: selectedSource?.kind,
      suggestedTargetId: appAudioTargetsResult.suggestedTargetId
    });
    const shouldResolveAppAudioTargets =
      isOpen && appAudioTargetBehavior.shouldResolveAppAudioTargets;
    const requiresManualAppAudioTarget =
      shouldResolveAppAudioTargets &&
      appAudioTargetBehavior.requiresManualAppAudioTarget;
    const resolvedAppAudioTargetId = requiresManualAppAudioTarget
      ? selectedAppAudioTargetId
      : appAudioTargetsResult.suggestedTargetId;
    const canConfirmShare =
      hasSources &&
      !!selectedSourceId &&
      (!shouldResolveAppAudioTargets || !!resolvedAppAudioTargetId);

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
        appAudioTargetId: resolvedAppAudioTargetId
      });
    };

    const onCancelClick = () => {
      onCancel?.();
    };

    useEffect(() => {
      if (!isOpen) {
        return;
      }

      setSelectedSourceId(sources[0]?.id);
      setAudioMode(defaultAudioMode);
      setSelectedAppAudioTargetId(undefined);
      setAppAudioTargetsResult({
        targets: []
      });
      setLoadingAppAudioTargets(false);
    }, [isOpen, sources, defaultAudioMode]);

    useEffect(() => {
      if (!shouldResolveAppAudioTargets || !selectedSourceId) {
        setLoadingAppAudioTargets(false);
        setAppAudioTargetsResult({
          targets: []
        });
        setSelectedAppAudioTargetId(undefined);
        return;
      }

      const desktopBridge = getDesktopBridge();

      if (!desktopBridge) {
        setAppAudioTargetsResult({
          targets: [],
          warning: 'Desktop bridge is unavailable for per-app audio.'
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
          setSelectedAppAudioTargetId((currentTargetId) => {
            if (
              currentTargetId &&
              result.targets.some((target) => target.id === currentTargetId)
            ) {
              return currentTargetId;
            }

            return result.suggestedTargetId || result.targets[0]?.id;
          });
        })
        .catch(() => {
          if (cancelled) {
            return;
          }

          setAppAudioTargetsResult({
            targets: [],
            warning: 'Failed to load running app targets.'
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
    }, [selectedSourceId, shouldResolveAppAudioTargets]);

    return (
      <Dialog open={isOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Share Screen</DialogTitle>
            <DialogDescription>{sourceLabel}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">
                System Audio: {supportLabelMap[capabilities.systemAudio]}
              </Badge>
              <Badge variant="outline">
                Per-App Audio: {supportLabelMap[capabilities.perAppAudio]}
              </Badge>
              <Badge variant="outline">Platform: {capabilities.platform}</Badge>
            </div>

            {capabilities.notes.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1">
                {capabilities.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Fullscreen or exclusive apps may only be shareable by selecting a
              display.
            </p>

            <div>
              <label className="text-sm font-medium">Audio mode</label>
              <Select
                value={audioMode}
                onValueChange={(value) =>
                  setAudioMode(value as ScreenAudioMode)
                }
              >
                <SelectTrigger className="mt-2 w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={ScreenAudioMode.SYSTEM}>
                      System audio
                    </SelectItem>
                    <SelectItem value={ScreenAudioMode.APP}>
                      Per-app audio
                    </SelectItem>
                    <SelectItem value={ScreenAudioMode.NONE}>
                      No shared audio
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {shouldResolveAppAudioTargets && (
              <div className="space-y-2">
                <label className="text-sm font-medium">App audio source</label>

                {loadingAppAudioTargets && (
                  <p className="text-xs text-muted-foreground">
                    Detecting running applications...
                  </p>
                )}

                {!loadingAppAudioTargets &&
                  appAudioTargetsResult.warning &&
                  appAudioTargetsResult.warning.trim() && (
                    <p className="text-xs text-amber-300">
                      {appAudioTargetsResult.warning}
                    </p>
                  )}

                {!loadingAppAudioTargets &&
                  !requiresManualAppAudioTarget &&
                  appAudioTargetsResult.suggestedTargetId && (
                    <p className="text-xs text-muted-foreground">
                      Auto-matched a window owner app for isolated audio.
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
                      No running app targets were found.
                    </p>
                  )}
              </div>
            )}

            <div className="max-h-[420px] overflow-y-auto pr-1 space-y-4">
              {displaySources.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Displays
                  </p>
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
                              : 'border-border hover:border-primary/40'
                          )}
                        >
                          <img
                            src={source.thumbnailDataUrl}
                            alt={source.name}
                            className="h-36 w-full object-cover bg-muted"
                          />
                          <div className="p-3 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {source.name}
                              </span>
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
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Windows
                  </p>
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
                              : 'border-border hover:border-primary/40'
                          )}
                        >
                          <img
                            src={source.thumbnailDataUrl}
                            alt={source.name}
                            className="h-36 w-full object-cover bg-muted"
                          />
                          <div className="p-3 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {source.name}
                              </span>
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
            <Button
              onClick={onSubmit}
              disabled={!canConfirmShare}
            >
              Share
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export { ScreenSharePickerDialog };
