import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Fragment } from 'react';
import clsx from 'clsx';
import { getMediaUrl } from '../utils.js';
import { TweetMediaVideo } from './tweet-media-video.js';
import { MediaImg } from './media-img.js';
import s from './tweet-media.module.css';
const getSkeletonStyle = (media, itemCount)=>{
    let paddingBottom = 56.25 // default of 16x9
    ;
    // if we only have 1 item, show at original ratio
    if (itemCount === 1) paddingBottom = 100 / media.original_info.width * media.original_info.height;
    // if we have 2 items, double the default to be 16x9 total
    if (itemCount === 2) paddingBottom = paddingBottom * 2;
    return {
        width: media.type === 'photo' ? undefined : 'unset',
        paddingBottom: `${paddingBottom}%`
    };
};
export const TweetMedia = ({ tweet, components, quoted })=>{
    var _tweet_mediaDetails, _tweet_mediaDetails1;
    var _tweet_mediaDetails_length;
    const length = (_tweet_mediaDetails_length = (_tweet_mediaDetails = tweet.mediaDetails) == null ? void 0 : _tweet_mediaDetails.length) != null ? _tweet_mediaDetails_length : 0;
    var _components_MediaImg;
    const Img = (_components_MediaImg = components == null ? void 0 : components.MediaImg) != null ? _components_MediaImg : MediaImg;
    return /*#__PURE__*/ _jsx("div", {
        className: clsx(s.root, !quoted && s.rounded),
        children: /*#__PURE__*/ _jsx("div", {
            className: clsx(s.mediaWrapper, length > 1 && s.grid2Columns, length === 3 && s.grid3, length > 4 && s.grid2x2),
            children: (_tweet_mediaDetails1 = tweet.mediaDetails) == null ? void 0 : _tweet_mediaDetails1.map((media)=>/*#__PURE__*/ _jsx(Fragment, {
                    children: media.type === 'photo' ? /*#__PURE__*/ _jsxs("a", {
                        href: tweet.url,
                        className: clsx(s.mediaContainer, s.mediaLink),
                        target: "_blank",
                        rel: "noopener noreferrer",
                        children: [
                            /*#__PURE__*/ _jsx("div", {
                                className: s.skeleton,
                                style: getSkeletonStyle(media, length)
                            }),
                            /*#__PURE__*/ _jsx(Img, {
                                src: getMediaUrl(media, 'small'),
                                alt: media.ext_alt_text || 'Image',
                                className: s.image,
                                draggable: true
                            })
                        ]
                    }, media.media_url_https) : /*#__PURE__*/ _jsxs("div", {
                        className: s.mediaContainer,
                        children: [
                            /*#__PURE__*/ _jsx("div", {
                                className: s.skeleton,
                                style: getSkeletonStyle(media, length)
                            }),
                            /*#__PURE__*/ _jsx(TweetMediaVideo, {
                                tweet: tweet,
                                media: media
                            })
                        ]
                    }, media.media_url_https)
                }, media.media_url_https))
        })
    });
};
