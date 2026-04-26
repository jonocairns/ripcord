import { memo } from 'react';
import { loadApp } from '@/features/app/actions';
import { getPublicAssetUrl } from '@/helpers/get-file-url';
import { useStrictEffect } from '@/hooks/use-strict-effect';

const LoadingApp = memo(() => {
	useStrictEffect(() => {
		loadApp();
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center">
			<img src={getPublicAssetUrl('logo.webp')} alt="" aria-hidden="true" className="logo-loader" />
		</div>
	);
});

export { LoadingApp };
