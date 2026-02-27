import type { EnrichedQuotedTweet } from '../../utils.js';
import type { TwitterComponents } from '../types.js';
type Props = {
    tweet: EnrichedQuotedTweet;
    components?: TwitterComponents;
};
export declare const QuotedTweetHeader: ({ tweet, components }: Props) => import("react").JSX.Element;
export {};
