import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { QuotedTweetContainer } from './quoted-tweet-container.js';
import { QuotedTweetHeader } from './quoted-tweet-header.js';
import { QuotedTweetBody } from './quoted-tweet-body.js';
import { TweetMedia } from '../tweet-media.js';
export const QuotedTweet = ({ tweet, components })=>{
    var _tweet_mediaDetails;
    return /*#__PURE__*/ _jsxs(QuotedTweetContainer, {
        tweet: tweet,
        children: [
            /*#__PURE__*/ _jsx(QuotedTweetHeader, {
                tweet: tweet,
                components: components
            }),
            /*#__PURE__*/ _jsx(QuotedTweetBody, {
                tweet: tweet
            }),
            ((_tweet_mediaDetails = tweet.mediaDetails) == null ? void 0 : _tweet_mediaDetails.length) ? /*#__PURE__*/ _jsx(TweetMedia, {
                quoted: true,
                tweet: tweet
            }) : null
        ]
    });
};
