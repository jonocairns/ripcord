import { loadApp } from '@/features/app/actions';
import { getPublicAssetUrl } from '@/helpers/get-file-url';
import { useStrictEffect } from '@/hooks/use-strict-effect';
import { memo } from 'react';

const LoadingApp = memo(() => {
  useStrictEffect(() => {
    loadApp();
  }, []);

  return (
    <div className="flex flex-col justify-center items-center h-full">
      <img
        src={getPublicAssetUrl('logo.webp')}
        alt=""
        aria-hidden="true"
        className="logo-loader"
      />
    </div>
  );
});

export { LoadingApp };
