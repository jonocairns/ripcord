'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import s from './quoted-tweet-container.module.css';
export const QuotedTweetContainer = ({ tweet, children })=>/*#__PURE__*/ _jsx("div", {
        className: s.root,
        onClick: (e)=>{
            e.preventDefault();
            window.open(tweet.url, '_blank');
        },
        children: /*#__PURE__*/ _jsx("article", {
            className: s.article,
            children: children
        })
    });
