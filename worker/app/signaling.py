import logging

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)

from .config import STUN_URL

log = logging.getLogger("signaling")


async def handle_offer(worker, sdp: str, publish_answer, req_id: str) -> None:
    """Build a peer connection for `worker`, attach its video track, consume the
    browser's SDP offer and publish our answer back through the relay."""
    pc = RTCPeerConnection(
        configuration=RTCConfiguration(iceServers=[RTCIceServer(urls=[STUN_URL])])
    )
    worker.register_pc(pc)
    pc.addTrack(worker.new_track())

    @pc.on("connectionstatechange")
    async def on_state_change():
        log.info("pc %s -> %s", worker.camera_id, pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()

    await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await publish_answer(req_id, pc.localDescription.sdp)
