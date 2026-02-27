import { jsx as _jsx } from "react/jsx-runtime";
import { formatDate } from '../date-utils.js';
import s from './tweet-info-created-at.module.css';
export const TweetInfoCreatedAt = ({ tweet })=>{
    const createdAt = new Date(tweet.created_at);
    const formattedCreatedAtDate = formatDate(createdAt);
    return /*#__PURE__*/ _jsx("a", {
        className: s.root,
        href: tweet.url,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": formattedCreatedAtDate,
        children: /*#__PURE__*/ _jsx("time", {
            dateTime: createdAt.toISOString(),
            children: formattedCreatedAtDate
        })
    });
};
