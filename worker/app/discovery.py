import urllib.parse


def _default_probe(timeout_s):
    # Heavy import kept local so the pure tests don't need the lib.
    from wsdiscovery.discovery import ThreadedWSDiscovery
    from wsdiscovery import QName
    wsd = ThreadedWSDiscovery()
    wsd.start()
    try:
        nvt = QName("http://www.onvif.org/ver10/network/wsdl", "NetworkVideoTransmitter")
        services = wsd.searchServices(types=[nvt], timeout=timeout_s)
        xaddrs = []
        for s in services:
            xaddrs.extend(s.getXAddrs())
        return xaddrs
    finally:
        wsd.stop()


def _default_onvif_factory(host, port, user, password):
    from onvif import ONVIFCamera
    return ONVIFCamera(host, port, user, password)


def discover_onvif(username, password, timeout_s=5, *,
                   probe=_default_probe, onvif_factory=_default_onvif_factory):
    """Find ONVIF cameras and resolve each RTSP URL. Network primitives are
    injected so the mapping is host-testable without the ONVIF libs."""
    results = []
    seen = set()
    for xaddr in probe(timeout_s):
        parsed = urllib.parse.urlparse(xaddr)
        host = parsed.hostname
        port = parsed.port or 80
        if not host or host in seen:
            continue
        seen.add(host)
        entry = {"name": host, "ip": host, "hardware": None, "rtsp_url": None, "error": None}
        try:
            cam = onvif_factory(host, port, username, password)
            info = cam.devicemgmt.GetDeviceInformation()
            name = f"{getattr(info, 'Manufacturer', '') or ''} {getattr(info, 'Model', '') or ''}".strip()
            entry["name"] = name or host
            entry["hardware"] = getattr(info, "Model", None)
            media = cam.create_media_service()
            profiles = media.GetProfiles()
            token = profiles[0].token
            uri = media.GetStreamUri({
                "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                "ProfileToken": token,
            })
            entry["rtsp_url"] = uri.Uri
        except Exception as e:  # noqa: BLE001 - any device error → listed with an error
            entry["error"] = str(e)[:160]
        results.append(entry)
    return results
