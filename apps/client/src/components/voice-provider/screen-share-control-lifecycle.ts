type TSupersededScreenShareStart = {
	isCurrent: () => boolean;
	isCaptureLive: () => boolean;
	finishStart: () => void;
	restoreStage: () => void;
};

// Owner supersession can preserve capture for recovery. Settle only this
// transition's UI; keep its capture-ended callback valid through republishing.
const settleSupersededScreenShareStart = (deps: TSupersededScreenShareStart): void => {
	if (!deps.isCurrent()) return;
	if (deps.isCaptureLive()) deps.finishStart();
	else deps.restoreStage();
};

export { settleSupersededScreenShareStart };
