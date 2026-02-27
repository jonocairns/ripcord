import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import clsx from 'clsx';
import { AvatarImg } from './avatar-img.js';
import { VerifiedBadge } from './verified-badge.js';
import { HighlightedLabel } from './highlighted-label.js';
import s from './tweet-header.module.css';
export const TweetHeader = ({ tweet, components })=>{
    var _components_AvatarImg;
    const Img = (_components_AvatarImg = components == null ? void 0 : components.AvatarImg) != null ? _components_AvatarImg : AvatarImg;
    const { user } = tweet;
    return /*#__PURE__*/ _jsxs("div", {
        className: s.header,
        children: [
            /*#__PURE__*/ _jsxs("a", {
                href: tweet.url,
                className: s.avatar,
                target: "_blank",
                rel: "noopener noreferrer",
                children: [
                    /*#__PURE__*/ _jsx("div", {
                        className: clsx(s.avatarOverflow, user.profile_image_shape === 'Square' && s.avatarSquare),
                        children: /*#__PURE__*/ _jsx(Img, {
                            src: user.profile_image_url_https,
                            alt: user.name,
                            width: 48,
                            height: 48
                        })
                    }),
                    /*#__PURE__*/ _jsx("div", {
                        className: s.avatarOverflow,
                        children: /*#__PURE__*/ _jsx("div", {
                            className: s.avatarShadow
                        })
                    })
                ]
            }),
            /*#__PURE__*/ _jsxs("div", {
                className: s.author,
                children: [
                    /*#__PURE__*/ _jsxs("a", {
                        href: tweet.url,
                        className: s.authorLink,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        children: [
                            /*#__PURE__*/ _jsx("div", {
                                className: s.authorLinkText,
                                children: /*#__PURE__*/ _jsx("span", {
                                    title: user.name,
                                    children: user.name
                                })
                            }),
                            /*#__PURE__*/ _jsx(VerifiedBadge, {
                                user: user,
                                className: s.authorVerified
                            }),
                            /*#__PURE__*/ _jsx(HighlightedLabel, {
                                user: user
                            })
                        ]
                    }),
                    /*#__PURE__*/ _jsxs("div", {
                        className: s.authorMeta,
                        children: [
                            /*#__PURE__*/ _jsx("a", {
                                href: tweet.url,
                                className: s.username,
                                target: "_blank",
                                rel: "noopener noreferrer",
                                children: /*#__PURE__*/ _jsxs("span", {
                                    title: `@${user.screen_name}`,
                                    children: [
                                        "@",
                                        user.screen_name
                                    ]
                                })
                            }),
                            /*#__PURE__*/ _jsxs("div", {
                                className: s.authorFollow,
                                children: [
                                    /*#__PURE__*/ _jsx("span", {
                                        className: s.separator,
                                        children: "·"
                                    }),
                                    /*#__PURE__*/ _jsx("a", {
                                        href: user.follow_url,
                                        className: s.follow,
                                        target: "_blank",
                                        rel: "noopener noreferrer",
                                        children: "Follow"
                                    })
                                ]
                            })
                        ]
                    })
                ]
            }),
            /*#__PURE__*/ _jsx("a", {
                href: tweet.url,
                className: s.brand,
                target: "_blank",
                rel: "noopener noreferrer",
                "aria-label": "View on Twitter",
                children: /*#__PURE__*/ _jsx("svg", {
                    viewBox: "0 0 24 24",
                    "aria-hidden": "true",
                    className: s.twitterIcon,
                    children: /*#__PURE__*/ _jsx("g", {
                        children: /*#__PURE__*/ _jsx("path", {
                            d: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                        })
                    })
                })
            })
        ]
    });
};
