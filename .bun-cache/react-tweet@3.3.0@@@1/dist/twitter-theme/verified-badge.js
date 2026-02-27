import { jsx as _jsx } from "react/jsx-runtime";
import clsx from 'clsx';
import { Verified, VerifiedBusiness, VerifiedGovernment } from './icons/index.js';
import s from './verified-badge.module.css';
export const VerifiedBadge = ({ user, className })=>{
    const verified = user.verified || user.is_blue_verified || user.verified_type;
    let icon = /*#__PURE__*/ _jsx(Verified, {});
    let iconClassName = s.verifiedBlue;
    if (verified) {
        if (!user.is_blue_verified) {
            iconClassName = s.verifiedOld;
        }
        switch(user.verified_type){
            case 'Government':
                icon = /*#__PURE__*/ _jsx(VerifiedGovernment, {});
                iconClassName = s.verifiedGovernment;
                break;
            case 'Business':
                icon = /*#__PURE__*/ _jsx(VerifiedBusiness, {});
                iconClassName = null;
                break;
        }
    }
    return verified ? /*#__PURE__*/ _jsx("div", {
        className: clsx(className, iconClassName),
        children: icon
    }) : null;
};
