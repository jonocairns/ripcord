import type { AppData, Producer } from 'mediasoup-client/types';
import { type MutableRefObject, useEffect } from 'react';
import { logVoice } from '@/helpers/browser-logger';
import { VIDEO_DEGRADATION_PREFERENCE } from '../video-encoding-constants';

// Runtime quality guard for the local screen-share producer, driven by the
// sender's outbound-rtp stats.
//
// Resolution floor: under a loss burst the encoder can crush the share far
// below watchable (e.g. 320x180) and GCC's additive ramp takes minutes to
// climb back. When the sent resolution stays below the floor while
// quality-limited, the sender is pinned to the floor resolution with
// 'maintain-resolution' so frame rate absorbs the remaining pressure; once
// the limitation clears it is restored to 'balanced' at full resolution.

const POLL_INTERVAL_MS = 2_000;
const FLOOR_SAMPLES_BEFORE_APPLY = 3;
const FLOOR_SAMPLES_BEFORE_RESTORE = 5;
const FLOOR_MIN_HEIGHT_PX = 360;
const FLOOR_CAPTURE_DIVISOR = 2;
// After releasing the floor, wait before re-applying it so a marginal link
// doesn't thrash setParameters on every degradation cycle.
const FLOOR_REAPPLY_COOLDOWN_MS = 15_000;
const QUALITY_LIMITATION_REASONS_FOR_FLOOR = new Set(['bandwidth', 'cpu']);

type TScreenShareQualityGuardParams = {
	screenShareProducerRef: MutableRefObject<Producer<AppData> | undefined>;
	// True while a local screen share is live; the guard only polls then.
	active: boolean;
};

const useScreenShareQualityGuard = ({ screenShareProducerRef, active }: TScreenShareQualityGuardParams) => {
	useEffect(() => {
		if (!active) {
			return;
		}

		let disposed = false;
		let isTicking = false;
		let trackedProducerId: string | undefined;
		let belowFloorSamples = 0;
		let recoveredSamples = 0;
		let floorApplied = false;
		let floorCooldownUntil = 0;

		const resetForProducer = (producerId: string) => {
			trackedProducerId = producerId;
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

				params.degradationPreference = VIDEO_DEGRADATION_PREFERENCE;
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

				let outbound:
					| {
							frameHeight?: number;
							qualityLimitationReason?: string;
					  }
					| undefined;

				for (const stat of statsReport.values()) {
					if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
						outbound = stat;
					}
				}

				if (!outbound) {
					return;
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

				// Release symmetrically with the apply condition: when the limitation
				// is no longer bandwidth/cpu for enough samples. Requiring exactly
				// 'none' would pin the floor forever if the browser settles on
				// 'other' (or stops reporting the field) after congestion clears; a
				// premature release just re-enters the apply path after its cooldown.
				const isStillQualityLimited = QUALITY_LIMITATION_REASONS_FOR_FLOOR.has(outbound.qualityLimitationReason ?? '');

				if (!isStillQualityLimited) {
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
