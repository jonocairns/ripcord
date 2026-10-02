import { t } from '../../utils/trpc';
import { deleteFileRoute } from './delete-file';
import { deleteTemporaryFileRoute } from './delete-temporary-file';
import { getAccessTokensRoute } from './get-access-tokens';

export const filesRouter = t.router({
	delete: deleteFileRoute,
	deleteTemporary: deleteTemporaryFileRoute,
	getAccessTokens: getAccessTokensRoute,
});
