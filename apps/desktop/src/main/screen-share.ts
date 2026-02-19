import { desktopCapturer, type DesktopCapturerSource } from "electron";
import type {
  TPreparedScreenShare,
  TShareSource,
  TScreenShareSelection,
} from "./types";

let preparedScreenShare: TPreparedScreenShare | undefined;

const prepareScreenShareSelection = (selection: TScreenShareSelection) => {
  preparedScreenShare = {
    sourceId: selection.sourceId,
    audioMode: selection.audioMode,
    appAudioTargetId: selection.appAudioTargetId,
  };
};

const consumeScreenShareSelection = () => {
  const currentSelection = preparedScreenShare;
  preparedScreenShare = undefined;
  return currentSelection;
};

const getDesktopSources = async () => {
  return desktopCapturer.getSources({
    types: ["screen", "window"],
    fetchWindowIcons: true,
    thumbnailSize: {
      width: 360,
      height: 210,
    },
  });
};

const serializeSource = (source: DesktopCapturerSource): TShareSource => {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon?.toDataURL(),
  };
};

const listShareSources = async (): Promise<TShareSource[]> => {
  const sources = await getDesktopSources();
  return sources.map(serializeSource);
};

const getSourceById = async (sourceId: string) => {
  const sources = await getDesktopSources();
  return sources.find((source) => source.id === sourceId);
};

export {
  consumeScreenShareSelection,
  getSourceById,
  listShareSources,
  prepareScreenShareSelection,
};
