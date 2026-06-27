export type TDesktopPlatform = 'windows' | 'macos' | 'linux';

export type TSupportLevel = 'supported' | 'best-effort' | 'unsupported';

export type TDesktopCapabilityIssueSeverity = 'info' | 'warning' | 'error';

export type TDesktopCapabilityIssueFeature = 'screen-share' | 'system-audio' | 'per-app-audio' | 'global-push-keybinds';

export type TDesktopCapabilityIssue = {
	code: string;
	affects: TDesktopCapabilityIssueFeature[];
	severity: TDesktopCapabilityIssueSeverity;
	title: string;
	message: string;
	guidance: string[];
};

export type TScreenAudioMode = 'system' | 'app' | 'none';

export type TShareSourceKind = 'screen' | 'window';

export type TShareSource = {
	id: string;
	name: string;
	kind: TShareSourceKind;
	appIconDataUrl?: string;
};

export type TScreenShareSelection = {
	sourceId: string;
	audioMode: TScreenAudioMode;
	appAudioTargetId?: string;
	useSystemPicker?: boolean;
};

export type TDesktopCapabilities = {
	platform: TDesktopPlatform;
	systemAudio: TSupportLevel;
	perAppAudio: TSupportLevel;
	globalPushKeybinds: TSupportLevel;
	sidecarAvailable?: boolean;
	issues: TDesktopCapabilityIssue[];
	notes: string[];
};

export type TPreparedScreenShare = {
	sourceId: string;
	audioMode: TScreenAudioMode;
	appAudioTargetId?: string;
};

export type TResolvedScreenAudioMode = {
	requestedMode: TScreenAudioMode;
	effectiveMode: TScreenAudioMode;
	warning?: string;
};

export type TDesktopAppAudioTarget = {
	id: string;
	label: string;
	pid: number;
	processName: string;
};

export type TDesktopAppAudioTargetsResult = {
	targets: TDesktopAppAudioTarget[];
	suggestedTargetId?: string;
	requiresManualSelection?: boolean;
	warning?: string;
};

export type TStartAppAudioCaptureInput = {
	sourceId: string;
	appAudioTargetId?: string;
	selfExcludePid?: number;
};

export type TAppAudioSession = {
	sessionId: string;
	targetId: string;
	sampleRate: number;
	channels: number;
	framesPerBuffer: number;
	protocolVersion?: number;
	encoding?: 'f32le_base64';
};

export type TStartAppAudioCaptureOptions = {
	// When false, capture starts without opening the renderer worklet frame
	// channel — used by native RTP ingest, where main consumes the PCM egress.
	openFrameChannel?: boolean;
};

// Target the renderer hands to main to start native RTP ingest. The values come
// from the server's createAppAudioIngest response.
export type TAppAudioRtpTarget = {
	ip: string;
	port: number;
	ssrc: number;
	payloadType?: number;
};

export type TStartAppAudioRtpResult = {
	srtpKeyBase64: string;
};

export type TAppAudioFrame = {
	sessionId: string;
	targetId: string;
	sequence: number;
	sampleRate: number;
	channels: number;
	frameCount: number;
	pcmBase64: string;
	protocolVersion: number;
	encoding: 'f32le_base64';
	droppedFrameCount?: number;
};

export type TAppAudioPcmFrame = {
	sessionId: string;
	targetId: string;
	sequence: number;
	sampleRate: number;
	channels: number;
	frameCount: number;
	pcm: Float32Array;
	protocolVersion: number;
	droppedFrameCount?: number;
};

export type TAppAudioEndReason = 'capture_stopped' | 'app_exited' | 'capture_error' | 'device_lost' | 'sidecar_exited';

export type TAppAudioStatusEvent = {
	sessionId: string;
	targetId: string;
	reason: TAppAudioEndReason;
	error?: string;
	protocolVersion?: number;
};

export type TDesktopUpdateState =
	| 'disabled'
	| 'idle'
	| 'checking'
	| 'available'
	| 'not-available'
	| 'downloading'
	| 'downloaded'
	| 'error';

export type TDesktopUpdateStatus = {
	state: TDesktopUpdateState;
	currentVersion: string;
	availableVersion?: string;
	manualInstallRequired?: boolean;
	checkedAtIso?: string;
	percent?: number;
	bytesPerSecond?: number;
	transferredBytes?: number;
	totalBytes?: number;
	message?: string;
};

export type TPushKeybindKind = 'talk' | 'mute';

export type TDesktopPushKeybindsInput = {
	pushToTalkKeybind?: string;
	pushToMuteKeybind?: string;
};

export type TDesktopPushKeybindEvent = {
	kind: TPushKeybindKind;
	active: boolean;
};

export type TGlobalPushKeybindRegistrationResult = {
	talkRegistered: boolean;
	muteRegistered: boolean;
	errors: string[];
};

export type TDesktopQuitFlushStatus = 'succeeded' | 'skipped';

export type TDesktopQuitFlushResult = {
	status: TDesktopQuitFlushStatus;
	reason?: string;
};

export type TDesktopWindowControlsState = {
	platform: TDesktopPlatform;
	isMaximized: boolean;
	usesCustomTitlebar: boolean;
};

export type TDesktopErrorReportingConfig = {
	dsn?: string;
	ignoreErrors?: string[];
	tracingSampleRate?: number;
};

export type TDesktopProcessCrashSource = 'renderer' | 'child-process';

export type TDesktopProcessCrashEvent = {
	source: TDesktopProcessCrashSource;
	// For child-process crashes this is Electron's process `type` (e.g. "GPU",
	// "Utility", "Pepper Plugin"). For renderer crashes it is always "renderer".
	processType: string;
	// Electron crash reason: "crashed" | "oom" | "killed" | "abnormal-exit" |
	// "launch-failed" | "integrity-failure" | "clean-exit".
	reason: string;
	exitCode: number;
	// Present only for utility child processes.
	serviceName?: string;
	name?: string;
};
