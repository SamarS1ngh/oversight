import unittest
from app.discovery import discover_onvif


class _Info:
    Manufacturer = "Acme"
    Model = "Cam9"


class _Media:
    def GetProfiles(self):
        return [type("P", (), {"token": "t0"})()]

    def GetStreamUri(self, req):
        return type("U", (), {"Uri": "rtsp://192.168.1.64:554/s0"})()


class _DevMgmt:
    def GetDeviceInformation(self):
        return _Info()


class _Cam:
    def __init__(self):
        self.devicemgmt = _DevMgmt()

    def create_media_service(self):
        return _Media()


def probe_one(_timeout):
    return ["http://192.168.1.64/onvif/device_service"]


def factory_ok(host, port, user, password):
    return _Cam()


class TestDiscovery(unittest.TestCase):
    def test_maps_device_to_name_ip_rtsp(self):
        r = discover_onvif("u", "p", probe=probe_one, onvif_factory=factory_ok)
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["ip"], "192.168.1.64")
        self.assertEqual(r[0]["name"], "Acme Cam9")
        self.assertEqual(r[0]["rtsp_url"], "rtsp://192.168.1.64:554/s0")
        self.assertIsNone(r[0]["error"])

    def test_getstreamuri_failure_sets_error_no_crash(self):
        def factory_bad(host, port, user, password):
            raise RuntimeError("401 unauthorized")
        r = discover_onvif("u", "p", probe=probe_one, onvif_factory=factory_bad)
        self.assertEqual(len(r), 1)
        self.assertIsNone(r[0]["rtsp_url"])
        self.assertIn("401", r[0]["error"])
        self.assertEqual(r[0]["ip"], "192.168.1.64")  # still listed with its IP

    def test_empty_probe_returns_empty(self):
        self.assertEqual(discover_onvif("u", "p", probe=lambda t: [], onvif_factory=factory_ok), [])

    def test_dedupes_by_host(self):
        def probe_dup(_t):
            return ["http://192.168.1.64/onvif/device_service",
                    "http://192.168.1.64:8000/onvif/device_service"]
        r = discover_onvif("u", "p", probe=probe_dup, onvif_factory=factory_ok)
        self.assertEqual(len(r), 1)


if __name__ == "__main__":
    unittest.main()
