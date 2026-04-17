import { t } from '../../utils/trpc';
import { closeConsumerRoute } from './close-consumer';
import { closeProducerRoute } from './close-producer';
import { connectConsumerTransportRoute } from './connect-consumer-transport';
import { connectProducerTransportRoute } from './connect-producer-transport';
import { consumeRoute } from './consume';
import { createConsumerTransportRoute } from './create-consumer-transport';
import { createProducerTransportRoute } from './create-producer-transport';
import {
  onUserJoinVoiceRoute,
  onUserLeaveVoiceRoute,
  onUserUpdateVoiceStateRoute,
  onVoiceAddExternalStreamRoute,
  onVoiceNewProducerRoute,
  onVoiceProducerClosedRoute,
  onVoiceRemoveExternalStreamRoute,
  onVoiceSessionReplacedRoute,
  onVoiceStreamWatcherActivityRoute,
  onVoiceTransportFailedRoute,
  onVoiceUpdateExternalStreamRoute
} from './events';
import { getProducersRoute } from './get-producers';
import { joinVoiceRoute } from './join';
import { leaveVoiceRoute } from './leave';
import { produceRoute } from './produce';
import { restartConsumerIceRoute } from './restart-consumer-ice';
import { restartProducerIceRoute } from './restart-producer-ice';
import { restoreOrJoinVoiceRoute } from './restore-or-join';
import { resumeConsumerRoute } from './resume-consumer';
import { updateVoiceStateRoute } from './update-state';

export const voiceRouter = t.router({
  join: joinVoiceRoute,
  restoreOrJoin: restoreOrJoinVoiceRoute,
  leave: leaveVoiceRoute,
  updateState: updateVoiceStateRoute,
  createProducerTransport: createProducerTransportRoute,
  connectProducerTransport: connectProducerTransportRoute,
  createConsumerTransport: createConsumerTransportRoute,
  connectConsumerTransport: connectConsumerTransportRoute,
  closeConsumer: closeConsumerRoute,
  resumeConsumer: resumeConsumerRoute,
  closeProducer: closeProducerRoute,
  produce: produceRoute,
  consume: consumeRoute,
  restartProducerIce: restartProducerIceRoute,
  restartConsumerIce: restartConsumerIceRoute,
  getProducers: getProducersRoute,
  onJoin: onUserJoinVoiceRoute,
  onLeave: onUserLeaveVoiceRoute,
  onUpdateState: onUserUpdateVoiceStateRoute,
  onSessionReplaced: onVoiceSessionReplacedRoute,
  onNewProducer: onVoiceNewProducerRoute,
  onProducerClosed: onVoiceProducerClosedRoute,
  onStreamWatcherActivity: onVoiceStreamWatcherActivityRoute,
  onTransportFailed: onVoiceTransportFailedRoute,
  onAddExternalStream: onVoiceAddExternalStreamRoute,
  onUpdateExternalStream: onVoiceUpdateExternalStreamRoute,
  onRemoveExternalStream: onVoiceRemoveExternalStreamRoute
});
