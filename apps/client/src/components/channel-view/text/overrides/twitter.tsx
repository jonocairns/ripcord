import * as Sentry from '@sentry/react';
import { memo } from 'react';
import { Tweet } from 'react-tweet';
import { LinkOverride } from './link';

type TTwitterOverrideProps = {
	tweetId: string;
};

const TwitterOverride = memo(({ tweetId }: TTwitterOverrideProps) => {
	return (
		<Sentry.ErrorBoundary fallback={<LinkOverride link={`https://x.com/i/status/${tweetId}`} label="View post on X" />}>
			<Tweet id={tweetId} />
		</Sentry.ErrorBoundary>
	);
});

export { TwitterOverride };
