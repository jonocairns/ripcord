import { Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { getTRPCClient } from '@/lib/trpc';

type TSetupData = {
	setupToken: string;
	qrCodeDataUrl: string;
	secret: string;
	recoveryCodes: string[];
};

type TStep = 'idle' | 'setup-password' | 'setup' | 'confirm' | 'disable' | 'regenerate';
type TErrorField = 'password' | 'code';
const TOTP_CODE_LENGTH = 6;

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const getFieldError = (error: unknown, field: TErrorField): string | undefined => {
	if (!isRecord(error)) {
		return undefined;
	}

	const data = error.data;

	if (!isRecord(data)) {
		return undefined;
	}

	const zodError = data.zodError;

	if (!isRecord(zodError)) {
		return undefined;
	}

	const fieldErrors = zodError.fieldErrors;

	if (!isRecord(fieldErrors)) {
		return undefined;
	}

	const fieldError = fieldErrors[field];

	if (!Array.isArray(fieldError)) {
		return undefined;
	}

	const firstError = fieldError[0];

	return typeof firstError === 'string' ? firstError : undefined;
};

const getErrorMessage = (error: unknown): string | undefined => {
	return error instanceof Error ? error.message : undefined;
};

const TwoFactor = memo(() => {
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [step, setStep] = useState<TStep>('idle');
	const [setupData, setSetupData] = useState<TSetupData | null>(null);
	const [confirmCode, setConfirmCode] = useState('');
	const [confirmError, setConfirmError] = useState('');
	const [loading, setLoading] = useState(false);

	// Setup form
	const [setupPassword, setSetupPassword] = useState('');
	const [setupPasswordError, setSetupPasswordError] = useState('');

	// Disable form
	const [disablePassword, setDisablePassword] = useState('');
	const [disableCode, setDisableCode] = useState('');
	const [disableError, setDisableError] = useState('');

	// Regenerate form
	const [regenPassword, setRegenPassword] = useState('');
	const [regenCode, setRegenCode] = useState('');
	const [regenError, setRegenError] = useState('');
	const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

	const fetchStatus = useCallback(async () => {
		try {
			const trpc = getTRPCClient();
			const result = await trpc.users.totpStatus.query();
			setEnabled(result.enabled);
		} catch {
			setEnabled(false);
		}
	}, []);

	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	const onStartSetup = useCallback(async () => {
		if (!setupPassword) return;

		setLoading(true);
		setSetupPasswordError('');
		try {
			const trpc = getTRPCClient();
			const result = await trpc.users.totpGenerateSetup.mutate({ password: setupPassword });
			setSetupData(result);
			setStep('setup');
		} catch (error) {
			const msg = getFieldError(error, 'password') || getErrorMessage(error) || 'Failed to start 2FA setup';
			setSetupPasswordError(msg);
		} finally {
			setLoading(false);
		}
	}, [setupPassword]);

	const onConfirmSetup = useCallback(async () => {
		if (!setupData || confirmCode.length !== TOTP_CODE_LENGTH) return;

		setLoading(true);
		setConfirmError('');
		try {
			const trpc = getTRPCClient();
			await trpc.users.totpConfirmSetup.mutate({
				setupToken: setupData.setupToken,
				code: confirmCode,
			});
			setEnabled(true);
			setStep('idle');
			setSetupData(null);
			setConfirmCode('');
			toast.success('Two-factor authentication enabled');
		} catch (error) {
			const msg = getFieldError(error, 'code') || getErrorMessage(error) || 'Invalid code';
			setConfirmError(msg);
		} finally {
			setLoading(false);
		}
	}, [setupData, confirmCode]);

	const onDisable = useCallback(async () => {
		if (!disablePassword || disableCode.length !== TOTP_CODE_LENGTH) return;

		setLoading(true);
		setDisableError('');
		try {
			const trpc = getTRPCClient();
			await trpc.users.totpDisable.mutate({
				password: disablePassword,
				code: disableCode,
			});
			setEnabled(false);
			setStep('idle');
			setDisablePassword('');
			setDisableCode('');
			toast.success('Two-factor authentication disabled');
		} catch (error) {
			const msg =
				getFieldError(error, 'password') ||
				getFieldError(error, 'code') ||
				getErrorMessage(error) ||
				'Failed to disable 2FA';
			setDisableError(msg);
		} finally {
			setLoading(false);
		}
	}, [disablePassword, disableCode]);

	const onRegenerate = useCallback(async () => {
		if (!regenPassword || regenCode.length !== TOTP_CODE_LENGTH) return;

		setLoading(true);
		setRegenError('');
		try {
			const trpc = getTRPCClient();
			const result = await trpc.users.totpRegenerateRecoveryCodes.mutate({
				password: regenPassword,
				code: regenCode,
			});
			setNewRecoveryCodes(result.recoveryCodes);
			toast.success('Recovery codes regenerated');
		} catch (error) {
			const msg =
				getFieldError(error, 'password') ||
				getFieldError(error, 'code') ||
				getErrorMessage(error) ||
				'Failed to regenerate codes';
			setRegenError(msg);
		} finally {
			setLoading(false);
		}
	}, [regenPassword, regenCode]);

	const copyRecoveryCodes = useCallback((codes: string[]) => {
		navigator.clipboard.writeText(codes.join('\n'));
		toast.success('Recovery codes copied to clipboard');
	}, []);

	const downloadRecoveryCodes = useCallback((codes: string[]) => {
		const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
	}, []);

	if (enabled === null) return null;

	// Setup flow: password re-authentication
	if (step === 'setup-password') {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Set Up Two-Factor Authentication</CardTitle>
					<CardDescription>Enter your password to continue.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Group label="Password">
						<Input
							type="password"
							value={setupPassword}
							onChange={(e) => {
								setSetupPassword(e.target.value);
								setSetupPasswordError('');
							}}
							onEnter={onStartSetup}
						/>
					</Group>
					{setupPasswordError && <p className="text-xs text-destructive">{setupPasswordError}</p>}
				</CardContent>
				<CardFooter className="justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => {
							setStep('idle');
							setSetupPassword('');
							setSetupPasswordError('');
						}}
					>
						Cancel
					</Button>
					<Button onClick={onStartSetup} disabled={loading || !setupPassword}>
						Continue
					</Button>
				</CardFooter>
			</Card>
		);
	}

	// Setup flow: show QR code + recovery codes
	if (step === 'setup' && setupData) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Set Up Two-Factor Authentication</CardTitle>
					<CardDescription>
						Scan the QR code below with your authenticator app (Google Authenticator, Authy, etc).
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex justify-center">
						<img src={setupData.qrCodeDataUrl} alt="TOTP QR Code" className="w-48 h-48" />
					</div>

					<div className="space-y-1">
						<p className="text-xs text-muted-foreground">Can't scan? Enter this key manually:</p>
						<code className="block text-xs bg-muted p-2 rounded font-mono break-all select-all">
							{setupData.secret}
						</code>
					</div>

					<Separator />

					<div className="space-y-2">
						<p className="text-sm font-medium">Recovery Codes</p>
						<p className="text-xs text-muted-foreground">
							Save these codes in a safe place. Each code can only be used once. If you lose your authenticator, these
							are the only way to access your account.
						</p>
						<div className="grid grid-cols-2 gap-1 bg-muted p-3 rounded">
							{setupData.recoveryCodes.map((code) => (
								<code key={code} className="text-xs font-mono">
									{code}
								</code>
							))}
						</div>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => copyRecoveryCodes(setupData.recoveryCodes)}
								className="gap-1"
							>
								<Copy className="h-3 w-3" />
								Copy
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => downloadRecoveryCodes(setupData.recoveryCodes)}
								className="gap-1"
							>
								<Download className="h-3 w-3" />
								Download
							</Button>
						</div>
					</div>

					<Separator />

					<Group label="Verification Code">
						<div className="space-y-1">
							<Input
								value={confirmCode}
								onChange={(e) => {
									setConfirmCode(e.target.value);
									setConfirmError('');
								}}
								onEnter={onConfirmSetup}
								placeholder="Enter 6-digit code"
								maxLength={TOTP_CODE_LENGTH}
							/>
							<p className="text-xs text-muted-foreground">
								Enter a code from your authenticator app to confirm setup.
							</p>
							{confirmError && <p className="text-xs text-destructive">{confirmError}</p>}
						</div>
					</Group>
				</CardContent>
				<CardFooter className="justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => {
							setStep('idle');
							setSetupData(null);
							setConfirmCode('');
							setSetupPassword('');
						}}
					>
						Cancel
					</Button>
					<Button onClick={onConfirmSetup} disabled={loading || confirmCode.length !== TOTP_CODE_LENGTH}>
						Enable 2FA
					</Button>
				</CardFooter>
			</Card>
		);
	}

	// Disable flow
	if (step === 'disable') {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Disable Two-Factor Authentication</CardTitle>
					<CardDescription>Enter your password and a current authentication code to disable 2FA.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Group label="Password">
						<Input
							type="password"
							value={disablePassword}
							onChange={(e) => {
								setDisablePassword(e.target.value);
								setDisableError('');
							}}
						/>
					</Group>
					<Group label="Authentication Code">
						<Input
							value={disableCode}
							onChange={(e) => {
								setDisableCode(e.target.value);
								setDisableError('');
							}}
							onEnter={onDisable}
							placeholder="Enter 6-digit code"
							maxLength={TOTP_CODE_LENGTH}
						/>
					</Group>
					{disableError && <p className="text-xs text-destructive">{disableError}</p>}
				</CardContent>
				<CardFooter className="justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => {
							setStep('idle');
							setDisablePassword('');
							setDisableCode('');
							setDisableError('');
						}}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={onDisable}
						disabled={loading || !disablePassword || disableCode.length !== TOTP_CODE_LENGTH}
					>
						Disable 2FA
					</Button>
				</CardFooter>
			</Card>
		);
	}

	// Regenerate recovery codes flow
	if (step === 'regenerate') {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Regenerate Recovery Codes</CardTitle>
					<CardDescription>This will invalidate your previous recovery codes and generate new ones.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{!newRecoveryCodes ? (
						<>
							<Group label="Password">
								<Input
									type="password"
									value={regenPassword}
									onChange={(e) => {
										setRegenPassword(e.target.value);
										setRegenError('');
									}}
								/>
							</Group>
							<Group label="Authentication Code">
								<Input
									value={regenCode}
									onChange={(e) => {
										setRegenCode(e.target.value);
										setRegenError('');
									}}
									onEnter={onRegenerate}
									placeholder="Enter 6-digit code"
									maxLength={TOTP_CODE_LENGTH}
								/>
							</Group>
							{regenError && <p className="text-xs text-destructive">{regenError}</p>}
						</>
					) : (
						<div className="space-y-2">
							<p className="text-sm font-medium">New Recovery Codes</p>
							<p className="text-xs text-muted-foreground">
								Save these codes in a safe place. Your previous codes are no longer valid.
							</p>
							<div className="grid grid-cols-2 gap-1 bg-muted p-3 rounded">
								{newRecoveryCodes.map((code) => (
									<code key={code} className="text-xs font-mono">
										{code}
									</code>
								))}
							</div>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => copyRecoveryCodes(newRecoveryCodes)}
									className="gap-1"
								>
									<Copy className="h-3 w-3" />
									Copy
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => downloadRecoveryCodes(newRecoveryCodes)}
									className="gap-1"
								>
									<Download className="h-3 w-3" />
									Download
								</Button>
							</div>
						</div>
					)}
				</CardContent>
				<CardFooter className="justify-end gap-2">
					{!newRecoveryCodes ? (
						<>
							<Button
								variant="ghost"
								onClick={() => {
									setStep('idle');
									setRegenPassword('');
									setRegenCode('');
									setRegenError('');
								}}
							>
								Cancel
							</Button>
							<Button
								onClick={onRegenerate}
								disabled={loading || !regenPassword || regenCode.length !== TOTP_CODE_LENGTH}
							>
								Regenerate
							</Button>
						</>
					) : (
						<Button
							onClick={() => {
								setStep('idle');
								setNewRecoveryCodes(null);
								setRegenPassword('');
								setRegenCode('');
							}}
						>
							Done
						</Button>
					)}
				</CardFooter>
			</Card>
		);
	}

	// Default idle state
	return (
		<Card>
			<CardHeader>
				<CardTitle>Two-Factor Authentication</CardTitle>
				<CardDescription>
					{enabled
						? 'Your account is protected with two-factor authentication.'
						: 'Add an extra layer of security to your account by requiring a code from an authenticator app when you sign in.'}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-3">
					{enabled ? (
						<ShieldCheck className="h-5 w-5 text-green-500" />
					) : (
						<ShieldOff className="h-5 w-5 text-muted-foreground" />
					)}
					<span className="text-sm">
						{enabled ? 'Two-factor authentication is enabled.' : 'Two-factor authentication is not enabled.'}
					</span>
				</div>
			</CardContent>
			<CardFooter className="justify-end gap-2">
				{enabled ? (
					<>
						<Button variant="outline" onClick={() => setStep('regenerate')}>
							Regenerate Recovery Codes
						</Button>
						<Button variant="destructive" onClick={() => setStep('disable')}>
							Disable 2FA
						</Button>
					</>
				) : (
					<Button onClick={() => setStep('setup-password')} disabled={loading}>
						Enable 2FA
					</Button>
				)}
			</CardFooter>
		</Card>
	);
});

export { TwoFactor };
