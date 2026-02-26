import { loadApp } from '@/features/app/actions';
import { useStrictEffect } from '@/hooks/use-strict-effect';
import { memo } from 'react';

const LoadingApp = memo(() => {
  useStrictEffect(() => {
    loadApp();
  }, []);

  return (
    <div className="flex flex-col justify-center items-center h-full">
      <div className="logo-loader" aria-hidden="true" />
    </div>
  );
});

export { LoadingApp };
