import { CheckCircle2, XCircle } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { TCommandResponse } from './types';

type TResponseProps = {
	response: TCommandResponse;
};

const Response = memo(({ response }: TResponseProps) => {
	return (
		<div className="mt-6">
			<h3 className="font-medium text-sm mb-2">Response</h3>
			<div
				className={cn(
					'p-4 rounded-lg border',
					response.success ? 'bg-success/10 border-success/30' : 'bg-destructive/10 border-destructive/30',
				)}
			>
				<div className="flex items-start gap-2">
					{response.success ? (
						<CheckCircle2 className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
					) : (
						<XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
					)}
					<div className="flex-1 min-w-0">
						{response.success ? (
							<div>
								<p className="font-medium text-sm text-success mb-2">Command executed successfully</p>
								{response.data !== undefined && (
									<pre className="text-xs bg-foreground/10 p-3 rounded overflow-x-auto">
										{JSON.stringify(response.data, null, 2)}
									</pre>
								)}
							</div>
						) : (
							<div>
								<p className="font-medium text-sm text-destructive mb-1">Command failed</p>
								<p className="text-sm text-destructive/90">{response.error}</p>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

export { Response };
