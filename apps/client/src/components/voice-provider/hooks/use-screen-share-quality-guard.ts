import type { AppData, Producer } from 'mediasoup-client/types';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { logVoice } from '@/helpers/browser-logger';

// Runtime quality guard for the local screen-share producer, driven by the
// sender's outbound-rtp stats. Two protections:
//
// 1. AV1 software-fallback watchdog. Hardware AV1 can silently fall back to
//    software libaom at runtime when congestion pushes the encode resolution
//    below the hardware encoder's minimum. libaom cannot sustain screen-share
//    encode: it underproduces, stalls the pacer, feeds the congestion
//    estimator more bad signal and pins the share at ~1fps with no climb-back.
//    The upfront powerEfficient probe only guards the *initial* codec choice,
//    so when AV1 is observed on a non-power-efficient encoder for consecutive
//    samples the producer is restarted on hardware H264.
//
// 2. Resolution floor. Under a loss burst the encoder can crush the share far
//    below watchable (e.g. 320x180) and GCC's additive ramp takes minutes to
//    climb back. When the sent resolution stays below the floor while
//    quality-limited, the sender is pinned to the floor resolution with
//    'maintain-resolution' so frame rate absorbs the remaining pressure; once
//    the limitation clears it is restored to 'balanced' at full resolution.
//    Keeping resolution at the floor also keeps AV1 inside the hardware
//    encoder's supported range, preventing trapdoor (1) from triggering.

const POLL_INTERVAL_MS = 2_000;
const AV1_SOFTWARE_SAMPLES_BEFORE_FALLBACK = 3;
const FLOOR_SAMPLES_BEFORE_APPLY = 3;
const FLOOR_SAMPLES_BEFORE_RESTORE = 5;
const FLOOR_MIN_HEIGHT_PX = 360;
const FLOOR_CAPTURE_DIVISOR = 2;
// After releasing the floor, wait before re-applying it so a marginal link
// doesn't thrash setParameters on every degradation cycle.
const FLOOR_REAPPLY_COOLDOWN_MS = 15_000;
const QUALITY_LIMITATION_REASONS_FOR_FLOOR = new Set(['bandwidth', 'cpu']);

// Keep in sync with VIDEO_DEGRADATION_PREFERENCE in the voice provider (not
// imported to avoid a hook -> provider import cycle).
const RESTORE_DEGRADATION_PREFERENCE: RTCDegradationPreference = 'balanced';

type TScreenShareQualityGuardParams = {
	screenShareProducerRef: MutableRefObject<Producer<AppData> | undefined>;
	// True while a local screen share is live; the guard only polls then.
	active: boolean;
	// Restart the screen-share producer on hardware H264. Invoked at most once
	// per producer when AV1 is detected running on a software encoder.
	onAv1SoftwareFallback: () => Promise<void>;
};

const useScreenShareQualityGuard = ({
	screenShareProducerRef,
	active,
	onAv1SoftwareFallback,
}: TScreenShareQualityGuardParams) => {
	const onAv1SoftwareFallbackRef = useRef(onAv1SoftwareFallback);
	onAv1SoftwareFallbackRef.current = onAv1SoftwareFallback;

	useEffect(() => {
		if (!active) {
			return;
		}

		let disposed = false;
		let isTicking = false;
		let trackedProducerId: string | undefined;
		let av1SoftwareSamples = 0;
		let av1FallbackRequested = false;
		let belowFloorSamples = 0;
		let recoveredSamples = 0;
		let floorApplied = false;
		let floorCooldownUntil = 0;

		const resetForProducer = (producerId: string) => {
			trackedProducerId = producerId;
			av1SoftwareSamples = 0;
			av1FallbackRequested = false;
			belowFloorSamples = 0;
			recoveredSamples = 0;
			// A new producer starts with fresh encodings, so any previously
			// applied floor is gone with the old sender.
			floorApplied = false;
			floorCooldownUntil = 0;
		};

		const applyResolutionFloor = async (sender: RTCRtpSender, captureHeight: number, floorHeight: number) => {
			try {
				// getParameters/setParameters are coupled by transactionId — keep this
				// read-modify-write free of awaits in between (see the note on
				// applyVideoDegradationPreference in the voice provider).
				const params = sender.getParameters();
				const encoding = params.encodings?.[0];

				if (!encoding) {
					return;
				}

				encoding.scaleResolutionDownBy = Math.max(1, captureHeight / floorHeight);
				params.degradationPreference = 'maintain-resolution';
				await sender.setParameters(params);

				floorApplied = true;
				belowFloorSamples = 0;
				recoveredSamples = 0;
				logVoice('Screen share resolution floor applied', {
					captureHeight,
					floorHeight,
				});
			} catch (error) {
				belowFloorSamples = 0;
				logVoice('Failed to apply screen share resolution floor', { error });
			}
		};

		const releaseResolutionFloor = async (sender: RTCRtpSender) => {
			try {
				const params = sender.getParameters();
				const encoding = params.encodings?.[0];

				if (encoding) {
					encoding.scaleResolutionDownBy = 1;
				}

				params.degradationPreference = RESTORE_DEGRADATION_PREFERENCE;
				await sender.setParameters(params);

				floorApplied = false;
				belowFloorSamples = 0;
				recoveredSamples = 0;
				floorCooldownUntil = Date.now() + FLOOR_REAPPLY_COOLDOWN_MS;
				logVoice('Screen share resolution floor released');
			} catch (error) {
				recoveredSamples = 0;
				logVoice('Failed to release screen share resolution floor', { error });
			}
		};

		const tick = async () => {
			if (isTicking) {
				return;
			}

			isTicking = true;

			try {
				const producer = screenShareProducerRef.current;
				const sender = producer?.rtpSender;

				if (!producer || producer.closed || !sender) {
					return;
				}

				if (producer.id !== trackedProducerId) {
					resetForProducer(producer.id);
				}

				let statsReport: RTCStatsReport;

				try {
					statsReport = await sender.getStats();
				} catch {
					return;
				}

				if (disposed || screenShareProducerRef.current !== producer) {
					return;
				}

				const codecMimeTypeById = new Map<string, string>();
				let outbound:
					| {
							codecId?: string;
							frameHeight?: number;
							qualityLimitationReason?: string;
							encoderImplementation?: string;
							powerEfficientEncoder?: boolean;
					  }
					| undefined;

				for (const stat of statsReport.values()) {
					if (stat.type === 'codec' && typeof stat.mimeType === 'string') {
						codecMimeTypeById.set(stat.id, stat.mimeType.toLowerCase());
					} else if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
						outbound = stat;
					}
				}

				if (!outbound) {
					return;
				}

				const codecMimeType = outbound.codecId ? codecMimeTypeById.get(outbound.codecId) : undefined;
				const isAv1 = codecMimeType === 'video/av1';
				const isSoftwareEncode =
					outbound.powerEfficientEncoder === false || /libaom/i.test(outbound.encoderImplementation ?? '');

				if (isAv1 && isSoftwareEncode) {
					av1SoftwareSamples += 1;

					if (!av1FallbackRequested && av1SoftwareSamples >= AV1_SOFTWARE_SAMPLES_BEFORE_FALLBACK) {
						av1FallbackRequested = true;
						logVoice('Screen share AV1 fell back to a software encoder, requesting H264 restart', {
							encoderImplementation: outbound.encoderImplementation,
							samples: av1SoftwareSamples,
						});
						void onAv1SoftwareFallbackRef.current();
						return;
					}
				} else {
					av1SoftwareSamples = 0;
				}

				const captureHeight = producer.track?.getSettings().height;

				if (typeof captureHeight !== 'number' || captureHeight <= 0) {
					return;
				}

				const floorHeight = Math.max(FLOOR_MIN_HEIGHT_PX, Math.round(captureHeight / FLOOR_CAPTURE_DIVISOR));

				if (captureHeight <= floorHeight) {
					return;
				}

				if (!floorApplied) {
					const sentHeight = outbound.frameHeight;
					const isQualityLimited = QUALITY_LIMITATION_REASONS_FOR_FLOOR.has(outbound.qualityLimitationReason ?? '');

					if (
						typeof sentHeight === 'number' &&
						sentHeight < floorHeight &&
						isQualityLimited &&
						Date.now() >= floorCooldownUntil
					) {
						belowFloorSamples += 1;

						if (belowFloorSamples >= FLOOR_SAMPLES_BEFORE_APPLY) {
							await applyResolutionFloor(sender, captureHeight, floorHeight);
						}
					} else {
						belowFloorSamples = 0;
					}

					return;
				}

				if (outbound.qualityLimitationReason === 'none') {
					recoveredSamples += 1;

					if (recoveredSamples >= FLOOR_SAMPLES_BEFORE_RESTORE) {
						await releaseResolutionFloor(sender);
					}
				} else {
					recoveredSamples = 0;
				}
			} finally {
				isTicking = false;
			}
		};

		const interval = setInterval(() => {
			void tick();
		}, POLL_INTERVAL_MS);

		return () => {
			disposed = true;
			clearInterval(interval);
		};
	}, [active, screenShareProducerRef]);
};

export { useScreenShareQualityGuard };
