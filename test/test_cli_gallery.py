"""The CLI's offline gallery keeps third-party badge text out of its markup.

usage: python3 test/test_cli_gallery.py
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import poap_saver  # noqa: E402

HOSTILE = ["<!--<script>", "</script><script>alert(1)</script>", "a < b", "<!-- x"]


class CliGallery(unittest.TestCase):
    def test_no_lt_in_the_data_inside_the_inline_script(self):
        rows = [{"c": "gnosis", "t": str(i), "e": i, "n": h, "d": h, "y": 2024,
                 "img": None, "sha": None, "uri": None, "src": None} for i, h in enumerate(HOSTILE)]
        html = poap_saver.gallery_html("0x0000000000000000000000000000000000000001", rows)
        data = re.search(r"var DATA = ([\s\S]*?);\nvar grid", html).group(1)
        self.assertNotIn("<", data, "a '<' in the inline script data can change how the browser reads it")
        self.assertIn("\\u003c!--\\u003cscript>", data, "the text itself went missing")


if __name__ == "__main__":
    unittest.main()
