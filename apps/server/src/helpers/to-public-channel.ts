import type { TChannel, TPublicChannel } from '@sharkord/shared';

const toPublicChannel = ({ fileAccessToken: _fileAccessToken, ...channel }: TChannel): TPublicChannel => channel;

export { toPublicChannel };
