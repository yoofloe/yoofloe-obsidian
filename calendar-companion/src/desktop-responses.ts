import { ResponsesSocketRound, type OpenLiveResponse } from "./responses-socket";

/** Called only on desktop. Load Node transport lazily so the mobile payload can still load. */
export const openDesktopResponse: OpenLiveResponse = async key => {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies -- The root package declares and bundles the desktop transport.
    const { default: WebSocket } = await import("ws");
    const socket = new WebSocket("wss://api.openai.com/v1/responses", {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 6000,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 34 * 1024 * 1024,
    });
    return await new Promise(resolve => {
      socket.once("open", () => resolve(new ResponsesSocketRound(socket, window)));
      // Keep an error listener even after a failed handshake.
      socket.on("error", () => resolve(null));
      socket.once("close", () => resolve(null));
    });
  } catch { return null; }
};
