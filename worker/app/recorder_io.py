import os

import av


class Mp4Muxer:
    """Remuxes demuxed H.264 packets into a faststart MP4 by codec-copy — no
    re-encode. Timestamps are rebased so the clip starts near zero."""

    def __init__(self, path, template_stream):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._path = path
        self._c = av.open(path, mode="w", options={"movflags": "+faststart"})
        self._out = self._c.add_stream(template=template_stream)
        self._first_dts = None

    def mux(self, packet):
        if packet.dts is None:
            return
        if self._first_dts is None:
            self._first_dts = packet.dts
        if packet.pts is not None:
            packet.pts = packet.pts - self._first_dts
        packet.dts = packet.dts - self._first_dts
        packet.stream = self._out
        self._c.mux(packet)

    def close(self):
        try:
            self._c.close()
        except Exception:
            pass

    def size(self):
        try:
            return os.path.getsize(self._path)
        except OSError:
            return 0
