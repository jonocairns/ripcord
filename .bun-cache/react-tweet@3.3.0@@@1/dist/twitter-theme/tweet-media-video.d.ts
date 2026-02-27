import type { MediaAnimatedGif, MediaVideo } from '../api/index.js';
import { EnrichedQuotedTweet, type EnrichedTweet } from '../utils.js';
type Props = {
    tweet: EnrichedTweet | EnrichedQuotedTweet;
    media: MediaAnimatedGif | MediaVideo;
};
export declare const TweetMediaVideo: ({ tweet, media }: Props) => import("react").JSX.Element;
export {};
