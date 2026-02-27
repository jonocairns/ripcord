import { jsx as _jsx } from "react/jsx-runtime";
import s from './quoted-tweet-body.module.css';
export const QuotedTweetBody = ({ tweet })=>/*#__PURE__*/ _jsx("p", {
        className: s.root,
        lang: tweet.lang,
        dir: "auto",
        children: tweet.entities.map((item, i)=>/*#__PURE__*/ _jsx("span", {
                dangerouslySetInnerHTML: {
                    __html: item.text
                }
            }, i))
    });
