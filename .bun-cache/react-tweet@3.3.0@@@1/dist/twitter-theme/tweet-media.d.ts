import { type EnrichedTweet, type EnrichedQuotedTweet } from '../utils.js';
import type { TwitterComponents } from './types.js';
type Props = {
    tweet: EnrichedTweet | EnrichedQuotedTweet;
    components?: TwitterComponents;
    quoted?: boolean;
};
export declare const TweetMedia: ({ tweet, components, quoted }: Props) => import("react").JSX.Element;
export {};
