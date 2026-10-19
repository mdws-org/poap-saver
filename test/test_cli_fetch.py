"""The CLI only fetches from public hosts over http(s), and a redirect never
downgrades https to http. Metadata and image URLs come from third parties, and
a rescue can run on a machine where loopback or the cloud metadata address
answers.

usage: python3 test/test_cli_fetch.py
"""
import http.server
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import poap_saver  # noqa: E402


class _Local(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = b'{"secret": "from a local service"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class PrivateDestinations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Local)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        poap_saver._CONNS.clear()

    def fetch_refused(self, url):
        with mock.patch.object(poap_saver.time, "sleep"):
            with self.assertRaises(Exception) as cm:
                poap_saver.fetch(url, tries=1)
        self.assertNotIn("local service", str(cm.exception))
        self.assertIn("refusing", str(cm.exception))

    def test_loopback_by_address_is_refused(self):
        self.fetch_refused(f"http://127.0.0.1:{self.port}/metadata/1")

    def test_loopback_by_name_is_refused(self):
        self.fetch_refused(f"http://localhost:{self.port}/metadata/1")

    def test_non_public_addresses_are_refused_before_connecting(self):
        for host in ("169.254.169.254", "10.0.0.1", "192.168.1.1", "172.16.0.1", "100.64.0.1",
                     "[::1]", "[fe80::1]", "0.0.0.0"):
            with self.subTest(host):
                with mock.patch.object(poap_saver.socket, "create_connection",
                                       side_effect=AssertionError("connected")) as cc:
                    self.fetch_refused(f"http://{host}/latest/meta-data/")
                cc.assert_not_called()

    def test_other_schemes_are_refused(self):
        for url in ("file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "gopher://example.com/"):
            with self.subTest(url):
                self.fetch_refused(url)


class Retries(unittest.TestCase):
    def test_a_refused_url_is_not_retried(self):
        poap_saver._CONNS.clear()
        with mock.patch.object(poap_saver.time, "sleep") as slept:
            with self.assertRaises(Exception):
                poap_saver.fetch("http://127.0.0.1:9/x", tries=3)
        slept.assert_not_called()


class _Resp:
    def __init__(self, status, headers, body=b""):
        self.status, self._headers, self._body = status, headers, body
        self.headers = self

    def get(self, k, default=None):
        return self._headers.get(k.lower(), default)

    def read(self):
        return self._body


class _FakeConn:
    def __init__(self, responses):
        self.responses = responses

    def request(self, *a, **k):
        pass

    def getresponse(self):
        return self.responses.pop(0)

    def close(self):
        pass


class Redirects(unittest.TestCase):
    def test_an_https_redirect_to_http_is_refused(self):
        conn = _FakeConn([
            _Resp(302, {"location": "http://api.poap.tech/metadata/1"}),
            _Resp(200, {"content-type": "application/json"}, b'{"name": "downgraded"}'),
        ])
        with mock.patch.object(poap_saver, "_conn", return_value=conn), \
                mock.patch.object(poap_saver, "_public_addrs", return_value=["203.0.113.7"], create=True), \
                mock.patch.object(poap_saver.time, "sleep"):
            with self.assertRaises(Exception):
                poap_saver.fetch("https://api.poap.tech/metadata/1", tries=1)

    def test_an_https_redirect_to_https_still_works(self):
        conn = _FakeConn([
            _Resp(302, {"location": "https://assets.poap.xyz/x.png"}),
            _Resp(200, {"content-type": "image/png"}, b"PNG"),
        ])
        with mock.patch.object(poap_saver, "_conn", return_value=conn), \
                mock.patch.object(poap_saver, "_public_addrs", return_value=["203.0.113.7"], create=True):
            data, ctype = poap_saver.fetch("https://api.poap.tech/img/1", binary=True, tries=1)
        self.assertEqual((data, ctype), (b"PNG", "image/png"))


if __name__ == "__main__":
    unittest.main()
