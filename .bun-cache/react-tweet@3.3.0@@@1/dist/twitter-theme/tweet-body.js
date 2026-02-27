import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { TweetLink } from './tweet-link.js';
import s from './tweet-body.module.css';
export const TweetBody = ({ tweet })=>/*#__PURE__*/ _jsxs("p", {
        className: s.root,
        lang: tweet.lang,
        dir: "auto",
        children: [
            tweet.entities.map((item, i)=>{
                switch(item.type){
                    case 'hashtag':
                    case 'mention':
                    case 'url':
                    case 'symbol':
                        return /*#__PURE__*/ _jsx(TweetLink, {
                            href: item.href,
                            children: item.text
                        }, i);
                    case 'media':
                        // Media text is currently never displayed, some tweets however might have indices
                        // that do match `display_text_range` so for those cases we ignore the content.
                        return;
                    default:
                        // We use `dangerouslySetInnerHTML` to preserve the text encoding.
                        // https://github.com/vercel/react-tweet/issues/29
                        return /*#__PURE__*/ _jsx("span", {
                            dangerouslySetInnerHTML: {
                                __html: item.text
                            }
                        }, i);
                }
            }),
            tweet.note_tweet ? /*#__PURE__*/ _jsx(ShowMore, {
                tweet: tweet
            }) : null
        ]
    });
function ShowMore({ tweet }) {
    return /*#__PURE__*/ _jsxs(TweetLink, {
        href: tweet.url,
        children: [
            /*#__PURE__*/ _jsx("span", {
                children: " "
            }),
            "Show more"
        ]
    });
}
