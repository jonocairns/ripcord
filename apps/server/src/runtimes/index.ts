import { ChannelType } from '@sharkord/shared';
import { getChannelsByType } from '../db/queries/channels/get-channels-by-type';
import { VoiceRuntime } from './voice';

const initVoiceRuntimes = async () => {
  const voiceChannels = await getChannelsByType(ChannelType.VOICE);

  for (const channel of voiceChannels) {
    const runtime = new VoiceRuntime(channel.id);

    await runtime.init();
  }
};

export { initVoiceRuntimes };
