import { Permission as EPermission, permissionDescriptions, permissionLabels } from '@sharkord/shared';
import { memo, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const permissionSections = [
	{
		title: 'Member permissions',
		permissions: [
			EPermission.SEND_MESSAGES,
			EPermission.REACT_TO_MESSAGES,
			EPermission.UPLOAD_FILES,
			EPermission.JOIN_VOICE_CHANNELS,
			EPermission.SHARE_SCREEN,
			EPermission.ENABLE_WEBCAM,
		],
	},
	{
		title: 'Content and community',
		permissions: [
			EPermission.MANAGE_MESSAGES,
			EPermission.MANAGE_USERS,
			EPermission.MANAGE_INVITES,
			EPermission.MANAGE_EMOJIS,
		],
	},
	{
		title: 'Server configuration',
		permissions: [
			EPermission.MANAGE_CHANNELS,
			EPermission.MANAGE_CHANNEL_PERMISSIONS,
			EPermission.MANAGE_CATEGORIES,
			EPermission.MANAGE_ROLES,
			EPermission.MANAGE_SETTINGS,
			EPermission.MANAGE_STORAGE,
			EPermission.MANAGE_UPDATES,
		],
	},
	{
		title: 'Plugins',
		permissions: [EPermission.MANAGE_PLUGINS, EPermission.EXECUTE_PLUGIN_COMMANDS],
	},
] as const;

type TPermissionProps = {
	permission: EPermission;
	enabled: boolean;
	onChange: (enabled: boolean) => void;
	disabled?: boolean;
};

const Permission = memo(({ permission, enabled, onChange, disabled }: TPermissionProps) => {
	return (
		<div className="flex items-start justify-between gap-4 p-4">
			<div className="flex flex-col">
				<Label className="text-sm">{permissionLabels[permission]}</Label>
				<span className="text-sm text-muted-foreground">{permissionDescriptions[permission]}</span>
			</div>
			<Switch checked={enabled} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
		</div>
	);
});

type TPermissionListProps = {
	permissions: EPermission[];
	setPermissions: (permissions: EPermission[]) => void;
	disabled?: boolean;
};

const PermissionList = memo(({ permissions, setPermissions, disabled }: TPermissionListProps) => {
	const onTogglePermission = useCallback(
		(permission: EPermission) => {
			if (permissions.includes(permission)) {
				setPermissions(permissions.filter((p) => p !== permission));
			} else {
				setPermissions([...permissions, permission]);
			}
		},
		[permissions, setPermissions],
	);

	return (
		<div className="space-y-5">
			<h3 className="text-sm font-semibold">Permissions</h3>

			<div className="space-y-4">
				{permissionSections.map((section) => (
					<div key={section.title} className="space-y-2">
						<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.title}</h4>
						<div className="divide-y divide-border overflow-hidden rounded-md border">
							{section.permissions.map((permission) => (
								<Permission
									key={permission}
									permission={permission}
									enabled={permissions.includes(permission)}
									onChange={() => onTogglePermission(permission)}
									disabled={disabled}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
});

export { PermissionList };
