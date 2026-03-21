import type { Permission } from '@sharkord/shared';
import { memo } from 'react';
import { useCan } from '@/features/server/hooks';

type TProtectProps = {
	children: React.ReactNode;
	fallback?: React.ReactNode;
	permission: Permission | Permission[];
};

const Protect = memo(({ children, fallback = null, permission }: TProtectProps) => {
	const can = useCan();

	return can(permission) ? <>{children}</> : <>{fallback}</>;
});

export { Protect };
