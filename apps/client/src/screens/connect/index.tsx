import { ArrowLeft } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { connect } from '@/features/server/actions';
import { useInfo } from '@/features/server/hooks';
import { getFileUrl, getPublicAssetUrl, getUrlFromServer } from '@/helpers/get-file-url';
import { getLocalStorageItem, LocalStorageKey, setAuthTokens, setLocalStorageItem } from '@/helpers/storage';
import { useForm } from '@/hooks/use-form';
import { getRuntimeServerConfig, normalizeServerUrl, updateDesktopServerUrl } from '@/runtime/server-config';

type TLoginResponse =
	| { success: true; token: string; refreshToken: string }
	| { requires2fa: true; challengeToken: string };

const Connect = memo(() => {
	const { values, r, setErrors } = useForm<{
		identity: string;
		password: string;
	}>({
		identity: getLocalStorageItem(LocalStorageKey.IDENTITY) || '',
		password: '',
	});

	const [loading, setLoading] = useState(false);
	const [savingServerUrl, setSavingServerUrl] = useState(false);
	const [desktopServerUrl, setDesktopServerUrl] = useState(getRuntimeServerConfig().serverUrl);
	const info = useInfo();

	// 2FA state
	const [twoFaChallenge, setTwoFaChallenge] = useState<string | null>(null);
	const [twoFaCode, setTwoFaCode] = useState('');
	const [twoFaError, setTwoFaError] = useState('');
	const [useRecoveryCode, setUseRecoveryCode] = useState(false);

	const inviteCode = useMemo(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const invite = urlParams.get('invite');
		return invite || undefined;
	}, []);

	const onConnectClick = useCallback(async () => {
		setLoading(true);

		try {
			const url = getUrlFromServer();
			const response = await fetch(`${url}/login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					identity: values.identity,
					password: values.password,
					invite: inviteCode,
				}),
			});

			if (!response.ok) {
				const data = await response.json();

				setErrors(data.errors || {});
				return;
			}

			const data = (await response.json()) as TLoginResponse;

			if ('requires2fa' in data) {
				setTwoFaChallenge(data.challengeToken);
				setTwoFaCode('');
				setTwoFaError('');
				return;
			}

			setAuthTokens(data.token, data.refreshToken);
			setLocalStorageItem(LocalStorageKey.IDENTITY, values.identity);

			await connect();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			toast.error(`Could not connect: ${errorMessage}`);
		} finally {
			setLoading(false);
		}
	}, [values.identity, values.password, setErrors, inviteCode]);

	const onVerify2fa = useCallback(async () => {
		if (!twoFaChallenge || !twoFaCode.trim()) return;

		setLoading(true);
		setTwoFaError('');

		try {
			const url = getUrlFromServer();
			const response = await fetch(`${url}/verify-2fa`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					challengeToken: twoFaChallenge,
					code: twoFaCode.trim(),
					isRecoveryCode: useRecoveryCode,
				}),
			});

			if (!response.ok) {
				const data = await response.json();
				const errorMsg = data.errors?.code || data.errors?.challengeToken || data.error || 'Verification failed';
				setTwoFaError(errorMsg);
				return;
			}

			const data = (await response.json()) as { success: true; token: string; refreshToken: string };

			setAuthTokens(data.token, data.refreshToken);
			setLocalStorageItem(LocalStorageKey.IDENTITY, values.identity);

			await connect();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			toast.error(`Could not verify: ${errorMessage}`);
		} finally {
			setLoading(false);
		}
	}, [twoFaChallenge, twoFaCode, useRecoveryCode, values.identity]);

	const onBack2fa = useCallback(() => {
		setTwoFaChallenge(null);
		setTwoFaCode('');
		setTwoFaError('');
		setUseRecoveryCode(false);
	}, []);

	const onSaveServerUrl = useCallback(async () => {
		setSavingServerUrl(true);

		try {
			const normalized = normalizeServerUrl(desktopServerUrl);
			await updateDesktopServerUrl(normalized.url);
			window.location.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not save server URL';

			toast.error(message);
			setSavingServerUrl(false);
		}
	}, [desktopServerUrl]);

	const logoSrc = useMemo(() => {
		if (info?.logo) {
			return getFileUrl(info.logo);
		}

		return getPublicAssetUrl('logo.webp');
	}, [info]);

	// 2FA verification step
	if (twoFaChallenge) {
		return (
			<div className="flex flex-col gap-2 justify-center items-center h-full">
				<Card className="w-full max-w-sm">
					<CardHeader>
						<CardTitle className="flex flex-col items-center gap-2 text-center">
							<img src={logoSrc} alt="Ripcord" className="w-32 h-32" />
						</CardTitle>
						<CardDescription className="text-center">
							{useRecoveryCode
								? 'Enter one of your recovery codes to sign in.'
								: 'Enter the 6-digit code from your authenticator app.'}
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Group label={useRecoveryCode ? 'Recovery Code' : 'Authentication Code'}>
							<Input
								value={twoFaCode}
								onChange={(e) => {
									setTwoFaCode(e.target.value);
									setTwoFaError('');
								}}
								onEnter={onVerify2fa}
								placeholder={useRecoveryCode ? 'xxxxxxxx' : '000000'}
								maxLength={useRecoveryCode ? 32 : 6}
								autoFocus
							/>
						</Group>

						{twoFaError && <p className="text-xs text-destructive">{twoFaError}</p>}

						<div className="flex flex-col gap-2">
							<Button
								className="w-full"
								variant="outline"
								onClick={onVerify2fa}
								disabled={loading || !twoFaCode.trim()}
							>
								Verify
							</Button>

							<div className="flex items-center justify-between">
								<Button variant="ghost" size="sm" onClick={onBack2fa} className="gap-1">
									<ArrowLeft className="h-3 w-3" />
									Back
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setUseRecoveryCode((prev) => !prev);
										setTwoFaCode('');
										setTwoFaError('');
									}}
								>
									{useRecoveryCode ? 'Use authenticator' : 'Use recovery code'}
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2 justify-center items-center h-full">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="flex flex-col items-center gap-2 text-center">
						<img src={logoSrc} alt="Ripcord" className="w-32 h-32" />
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{info?.description && <span className="text-sm text-muted-foreground">{info?.description}</span>}

					<div className="flex flex-col gap-2">
						<Group
							label="Identity"
							help="A unique identifier for your account on this server. You can use whatever you like, such as an email address or a username. This won't be shared publicly."
						>
							<Input {...r('identity')} />
						</Group>
						<Group label="Password">
							<Input {...r('password')} type="password" onEnter={onConnectClick} />
						</Group>
					</div>

					<div className="flex flex-col gap-2">
						{window.sharkordDesktop && (
							<Group label="Desktop Server URL">
								<div className="flex gap-2">
									<Input
										value={desktopServerUrl}
										onChange={(event) => setDesktopServerUrl(event.target.value)}
										onEnter={onSaveServerUrl}
										placeholder="http://localhost:4991"
									/>
									<Button
										variant="outline"
										onClick={onSaveServerUrl}
										disabled={!desktopServerUrl.trim() || savingServerUrl}
									>
										Save URL
									</Button>
								</div>
							</Group>
						)}

						{!info && (
							<Alert variant="destructive">
								<AlertTitle>Server Unavailable</AlertTitle>
								<AlertDescription>
									Could not fetch server info from the configured host. Verify the server URL and try again.
								</AlertDescription>
							</Alert>
						)}

						{!window.sharkordDesktop && !window.isSecureContext && (
							<Alert variant="destructive">
								<AlertTitle>Insecure Connection</AlertTitle>
								<AlertDescription>
									You are accessing the server over an insecure connection (HTTP). By default, browsers block access to
									media devices such as your camera and microphone on insecure origins. This means that you won't be
									able to use video or voice chat features while connected to the server over HTTP. If you are the
									server administrator, you can set up HTTPS by following the instructions in the documentation.
								</AlertDescription>
							</Alert>
						)}

						<Button
							className="w-full"
							variant="outline"
							onClick={onConnectClick}
							disabled={loading || !values.identity || !values.password}
						>
							Connect
						</Button>

						{!info?.allowNewUsers && (
							<>
								{!inviteCode && (
									<span className="text-xs text-muted-foreground text-center">
										New user registrations are currently disabled. If you do not have an account yet, you need to be
										invited by an existing user to join this server.
									</span>
								)}
							</>
						)}

						{inviteCode && (
							<Alert variant="info">
								<AlertTitle>You were invited to join this server</AlertTitle>
								<AlertDescription>
									<span className="font-mono text-xs">Invite code: {inviteCode}</span>
								</AlertDescription>
							</Alert>
						)}
					</div>
				</CardContent>
			</Card>

			<div className="flex justify-center gap-2 text-xs text-muted-foreground select-none">
				<span>v{VITE_APP_VERSION}</span>
				<a href="https://github.com/jonocairns/ripcord" target="_blank" rel="noopener noreferrer">
					GitHub
				</a>

				<a className="text-xs" href="https://ripcord.com" target="_blank" rel="noopener noreferrer">
					Ripcord
				</a>
			</div>
		</div>
	);
});

export { Connect };
