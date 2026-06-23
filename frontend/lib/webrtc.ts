"use client";
import { api } from "./api";
import { STUN_URL } from "./config";

// Establish a recvonly WebRTC connection to a camera. We use non-trickle ICE
// (wait for gathering to finish, send one offer) because the signaling relay is
// a single request/response — it matches the worker's aiortc side.
export async function connectCameraStream(
  cameraId: string,
  onStream: (stream: MediaStream) => void,
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: STUN_URL }],
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => {
    if (e.streams[0]) onStream(e.streams[0]);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceComplete(pc);

  const answer = await api.webrtcOffer(cameraId, pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  return pc;
}

function waitForIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, 2000); // fallback so we never hang forever
  });
}
