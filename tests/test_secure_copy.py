#!/usr/bin/env python3
"""Regression tests for secure workspace staging. Run: python3 -m unittest discover -s tests -p 'test_secure_copy.py'"""
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "copy-workspace-secure.py"

class SecureCopyTests(unittest.TestCase):
    def invoke(self, source, dest):
        return subprocess.run([sys.executable, str(SCRIPT), str(source), str(dest)], capture_output=True, text=True)

    def test_existing_destination_survives_failure(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            source, dest = root / "src", root / "dest"
            source.mkdir()
            dest.mkdir()
            (source / "file.txt").write_text("new")
            (dest / "keep.txt").write_text("important")
            result = self.invoke(source, dest)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((dest / "keep.txt").read_text(), "important")
            self.assertFalse((dest / "file.txt").exists())

    def test_rejected_symlink_preserves_existing_destination(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            source, dest = root / "src", root / "dest"
            source.mkdir()
            dest.mkdir()
            (dest / "keep.txt").write_text("important")
            (source / "unsafe").symlink_to("/etc/passwd")
            result = self.invoke(source, dest)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((dest / "keep.txt").read_text(), "important")

    def test_new_destination_copied_atomically(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            source, dest = root / "src", root / "dest"
            source.mkdir()
            (source / "file.txt").write_text("hello")
            result = self.invoke(source, dest)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((dest / "file.txt").read_text(), "hello")

    def test_failure_leaves_no_partial_destination(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            source, dest = root / "src", root / "dest"
            source.mkdir()
            (source / "unsafe").symlink_to("/etc/passwd")
            result = self.invoke(source, dest)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(dest.exists())
            self.assertFalse(list(root.glob(".cortex-copy-*")))

if __name__ == "__main__":
    unittest.main()
