import type { ReactNode } from 'react';
import type { EnrichedQuotedTweet } from '../../utils.js';
type Props = {
    tweet: EnrichedQuotedTweet;
    children: ReactNode;
};
export declare const QuotedTweetContainer: ({ tweet, children }: Props) => import("react").JSX.Element;
export {};
