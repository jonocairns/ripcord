import { memo } from 'react';
import { Tweet } from 'react-tweet';
import { ReportingBoundary } from '@/components/error-boundary/reporting-boundary';
import { LinkOverride } from './link';

type TTwitterOverrideProps = {
	tweetId: string;
};

const TwitterOverride = memo(({ tweetId }: TTwitterOverrideProps) => {
	return (
		<ReportingBoundary fallback={<LinkOverride link={`https://x.com/i/status/${tweetId}`} label="View post on X" />}>
			<Tweet id={tweetId} />
		</ReportingBoundary>
	);
});

export { TwitterOverride };
