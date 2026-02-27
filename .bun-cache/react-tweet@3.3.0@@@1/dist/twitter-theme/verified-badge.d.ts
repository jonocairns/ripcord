import type { TweetUser } from '../api/index.js';
type Props = {
    user: TweetUser;
    className?: string;
};
export declare const VerifiedBadge: ({ user, className }: Props) => import("react").JSX.Element | null;
export {};
