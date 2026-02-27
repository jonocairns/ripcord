import { jsx as _jsx } from "react/jsx-runtime";
import clsx from 'clsx';
import styles from './highlighted-label.module.css';
export const HighlightedLabel = ({ user, className })=>{
    var _label_badge;
    const label = user.highlighted_label;
    if (!label) return null;
    const url = (_label_badge = label.badge) == null ? void 0 : _label_badge.url;
    if (!url) return null;
    return /*#__PURE__*/ _jsx("div", {
        className: clsx(styles.label, className),
        children: /*#__PURE__*/ _jsx("img", {
            src: url,
            alt: label.description
        })
    });
};
