import type { Tweet } from './types/index.js';
/**
 * Returns a tweet from the Twitter syndication API.
 */
export declare function getTweet(id: string, fetchOptions?: RequestInit): Promise<Tweet | undefined>;
