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

const isScreenSource = (source: DesktopCapturerSource) => {
  return source.id.startsWith("screen:");
};

const fallbackSourceName = (source: DesktopCapturerSource) => {
  const idSegments = source.id.split(":");

  if (isScreenSource(source)) {
    const displayIndex = Number.parseInt(idSegments[1] ?? "", 10);
    if (Number.isFinite(displayIndex)) {
      return `Display ${displayIndex + 1}`;
    }

    return "Display";
  }

  const windowToken = idSegments[1];
  if (windowToken) {
    return `Window ${windowToken}`;
  }

  return "Window";
};

const compareSources = (left: DesktopCapturerSource, right: DesktopCapturerSource) => {
  const leftKindOrder = isScreenSource(left) ? 0 : 1;
  const rightKindOrder = isScreenSource(right) ? 0 : 1;

  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder - rightKindOrder;
  }

  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
};

const serializeSource = (source: DesktopCapturerSource): TShareSource => {
  const normalizedName = source.name.trim();

  return {
    id: source.id,
    name: normalizedName || fallbackSourceName(source),
    kind: isScreenSource(source) ? "screen" : "window",
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon?.toDataURL(),
  };
};

const listShareSources = async (): Promise<TShareSource[]> => {
  const sources = await getDesktopSources();
  return sources.sort(compareSources).map(serializeSource);
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
