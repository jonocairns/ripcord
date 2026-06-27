// A full WS-level reconnect owns voice recovery end-to-end (restore-or-join +
// re-init). While it is in progress, a media transport failing is expected and
// will be repaired by that flow, so the in-session transport-failure handler
// must defer rather than start a second, racing recovery (which would tear down
// the session the reconnect just restored).
const shouldDeferTransportFailureToReconnect = (reconnectingSince: number | undefined): boolean => {
	return reconnectingSince !== undefined;
};

export { shouldDeferTransportFailureToReconnect };
