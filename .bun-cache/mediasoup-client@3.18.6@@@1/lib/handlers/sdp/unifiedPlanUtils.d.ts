import type { RtpCodecParameters, RtpEncodingParameters } from '../../RtpParameters';
import type * as SdpTransform from 'sdp-transform';
export declare function getRtpEncodings({ offerMediaObject, codecs, }: {
    offerMediaObject: SdpTransform.MediaDescription;
    codecs: RtpCodecParameters[];
}): RtpEncodingParameters[];
/**
 * Adds multi-ssrc based simulcast into the given SDP media section offer.
 */
export declare function addLegacySimulcast({ offerMediaObject, numStreams, }: {
    offerMediaObject: SdpTransform.MediaDescription;
    numStreams: number;
}): void;
//# sourceMappingURL=unifiedPlanUtils.d.ts.map