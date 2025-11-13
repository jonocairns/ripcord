import { ChannelType, type TChannel } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '../..';
import { channels } from '../../schema';

const getChannelsByType = async (type: ChannelType): Promise<TChannel[]> =>
  db.select().from(channels).where(eq(channels.type, type)).all();

export { getChannelsByType };
