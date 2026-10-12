#!/opt/homebrew/bin/python3
"""css-touch-lint: mechanical checks for styles that break on a phone or a keyboard.

Rules (each one blocks; silence a deliberate exception with the text
`css-touch-lint: allow` on the offending line or the line above it):

  HOVER    a rule whose selector has :hover outside an @media block whose
           query contains `hover: hover`; on a touch screen the style sticks
           after a tap.
  OUTLINE  `outline: none` / `outline: 0` (focus ring removed), and the
           Tailwind `outline-none` utility in a class attribute. A rule
           scoped with :not(:focus-visible) is exempt.
  INVALID  :invalid in a selector where :user-invalid belongs; the form opens
           already red.
  TAILWIND a tailwind.config.* without `hoverOnlyWhenSupported`, so every
           hover: utility compiles to a bare :hover.
  INPUT    an input, select or textarea with a font-size under 16px (CSS rule
           or inline style); iOS Safari zooms the page when it gets focus.

Scans .css files whole and the <style> blocks of any other text file (HTML,
JS template strings, Astro, Svelte). Skips node_modules, dist, build, vendor,
archive, .git, .claude and *.min.css unless told otherwise.

Usage: css-touch-lint.py [PATH ...] [--exclude GLOB ...] [--list-rules] [--checksum]
Exit: 0 clean, 1 findings, 2 usage error.
"""
import argparse
import fnmatch
import hashlib
import os
import re
import sys

ALLOW = "css-touch-lint: allow"
CONFIG = ".css-touch-lint"
DEFAULT_EXCLUDE_DIRS = {".git", "node_modules", "dist", "build", "vendor", "archive", ".claude", "__pycache__"}
DEFAULT_EXCLUDE_FILES = ["*.min.css"]
TEXT_EXT = {".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".svelte", ".vue", ".astro", ".njk", ".php", ".erb", ".ejs", ".hbs"}

RULES = {
    "HOVER": ":hover outside @media (hover: hover) sticks after a tap on a touch screen",
    "OUTLINE": "focus ring removed (outline: none / 0, or the outline-none utility)",
    "INVALID": ":invalid marks a form red before anyone has typed; use :user-invalid",
    "TAILWIND": "tailwind.config without future.hoverOnlyWhenSupported emits bare :hover for every hover: utility",
    "INPUT": "input/select/textarea font-size under 16px makes iOS Safari zoom on focus",
}

HOVER_QUERY = re.compile(r"hover\s*:\s*hover")
OUTLINE_DECL = re.compile(r"(?<![\w-])outline\s*:\s*(none|0(px)?)\s*(!important)?\s*(;|$)", re.I)
FONT_SIZE_DECL = re.compile(r"(?<![\w-])font-size\s*:\s*([\d.]+)\s*(px|rem|em|pt)\b", re.I)
FORM_CONTROL = re.compile(r"(^|[\s>+~,(])(input|select|textarea)(?![\w-])", re.I)
INVALID_SEL = re.compile(r"(?<!user-):invalid\b")
STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style>", re.I | re.S)
OUTLINE_CLASS = re.compile(r"\bclass\s*=\s*([\"'])([^\"']*)\1", re.I)
INLINE_CONTROL = re.compile(r"<(input|select|textarea)\b[^>]*\bstyle\s*=\s*([\"'])([^\"']*)\2", re.I)


class Finding:
    def __init__(self, path, line, rule, detail):
        self.path, self.line, self.rule, self.detail = path, line, rule, detail

    def __str__(self):
        return f"{self.path}:{self.line}: {self.rule} {self.detail}"


def allowed(lines, line_no):
    """True when the finding's line or the one above carries the allow marker."""
    for n in (line_no, line_no - 1):
        if 1 <= n <= len(lines) and ALLOW in lines[n - 1]:
            return True
    return False


def blank_comments(css):
    """Replace comment bodies with spaces, keeping every newline so line numbers hold."""
    out = []
    i, n = 0, len(css)
    while i < n:
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            end = n if end < 0 else end + 2
            out.append("".join("\n" if c == "\n" else " " for c in css[i:end]))
            i = end
        else:
            out.append(css[i])
            i += 1
    return "".join(out)


def too_small(value, unit):
    size = float(value)
    return {"px": size < 16, "rem": size < 1, "em": size < 1, "pt": size < 12}[unit.lower()]


def walk_rules(css):
    """Yield (selector, declarations, line, hover_ok) for every style rule in css.

    Blocks are tracked with a stack; an at-rule block contributes its query to
    the context, a style rule's declarations exclude any nested blocks.
    """
    text = blank_comments(css)
    stack = []  # entries: dict(prelude, is_at, hover_ok, decl_parts, line)
    start = 0
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "{":
            prelude = text[start:i].strip()
            line = text.count("\n", 0, start) + 1 + _leading_newlines(text[start:i])
            is_at = prelude.startswith("@")
            parent_ok = stack[-1]["hover_ok"] if stack else False
            hover_ok = parent_ok or (is_at and bool(HOVER_QUERY.search(prelude)))
            stack.append({"prelude": prelude, "is_at": is_at, "hover_ok": hover_ok, "decl": [], "line": line})
            start = i + 1
        elif c == "}":
            if stack:
                entry = stack.pop()
                entry["decl"].append(text[start:i])
                if not entry["is_at"]:
                    yield entry["prelude"], " ".join(entry["decl"]), entry["line"], entry["hover_ok"]
            start = i + 1
        elif c == ";" and stack and not stack[-1]["is_at"]:
            pass
        i += 1


def _leading_newlines(s):
    return len(s) - len(s.lstrip("\n")) if s.startswith("\n") else 0


def nested_block_free(decls):
    """Strip any nested `{...}` so declarations of a parent rule read cleanly."""
    return re.sub(r"\{[^{}]*\}", " ", decls)


def lint_css(path, css, lines, offset=0):
    found = []
    for selector, decls, line, hover_ok in walk_rules(css):
        line += offset
        decls = nested_block_free(decls)
        if ":hover" in selector and not hover_ok:
            found.append(Finding(path, line, "HOVER", f"`{short(selector)}`"))
        if OUTLINE_DECL.search(decls) and ":not(:focus-visible)" not in selector:
            found.append(Finding(path, line, "OUTLINE", f"`{short(selector)}` removes the focus ring"))
        if INVALID_SEL.search(selector):
            found.append(Finding(path, line, "INVALID", f"`{short(selector)}`"))
        if FORM_CONTROL.search(selector):
            for m in FONT_SIZE_DECL.finditer(decls):
                if too_small(m.group(1), m.group(2)):
                    found.append(Finding(path, line, "INPUT", f"`{short(selector)}` font-size {m.group(1)}{m.group(2)}"))
    return [f for f in found if not allowed(lines, f.line)]


def short(selector):
    selector = " ".join(selector.split())
    return selector if len(selector) <= 60 else selector[:57] + "..."


def lint_markup(path, text, lines):
    """Checks on the markup itself: outline-none utilities and inline input sizes."""
    found = []
    for m in OUTLINE_CLASS.finditer(text):
        if re.search(r"(^|\s)outline-none(\s|$)", m.group(2)):
            found.append(Finding(path, line_of(text, m.start()), "OUTLINE", "class outline-none"))
    for m in INLINE_CONTROL.finditer(text):
        for fs in FONT_SIZE_DECL.finditer(m.group(3)):
            if too_small(fs.group(1), fs.group(2)):
                found.append(Finding(path, line_of(text, m.start()), "INPUT", f"inline <{m.group(1).lower()}> font-size {fs.group(1)}{fs.group(2)}"))
    return [f for f in found if not allowed(lines, f.line)]


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def lint_file(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as e:
        return [Finding(path, 0, "IO", str(e))]
    lines = text.split("\n")
    name = os.path.basename(path)
    if name.startswith("tailwind.config."):
        return [] if "hoverOnlyWhenSupported" in text else [Finding(path, 1, "TAILWIND", "add future: { hoverOnlyWhenSupported: true }")]
    ext = os.path.splitext(name)[1].lower()
    if ext == ".css":
        return lint_css(path, text, lines)
    if ext not in TEXT_EXT:
        return []
    found = lint_markup(path, text, lines)
    for m in STYLE_BLOCK.finditer(text):
        found.extend(lint_css(path, m.group(1), lines, offset=line_of(text, m.start(1)) - 1))
    return found


def excluded(name, patterns):
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def collect(paths, exclude_files):
    for root_path in paths:
        if os.path.isfile(root_path):
            yield root_path
            continue
        for dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = sorted(d for d in dirnames if d not in DEFAULT_EXCLUDE_DIRS and not excluded(d, exclude_files))
            for f in sorted(filenames):
                full = os.path.join(dirpath, f)
                if excluded(f, exclude_files) or excluded(os.path.relpath(full, root_path), exclude_files):
                    continue
                if f.startswith("tailwind.config.") or os.path.splitext(f)[1].lower() in TEXT_EXT | {".css"}:
                    yield full


def self_checksum():
    with open(os.path.realpath(__file__), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def config_args():
    """Arguments from a `.css-touch-lint` file in the current directory: one per line, `#` comments."""
    if not os.path.isfile(CONFIG):
        return []
    with open(CONFIG, encoding="utf-8") as fh:
        return [ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith("#")]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("paths", nargs="*", default=[], help=f"files or directories; with none given, {CONFIG} in the current directory supplies the arguments, else `.`")
    ap.add_argument("--exclude", action="append", default=[], metavar="GLOB", help="file or relative-path glob to skip (repeatable)")
    ap.add_argument("--list-rules", action="store_true")
    ap.add_argument("--checksum", action="store_true", help="print this script's sha256 and exit")
    argv = sys.argv[1:] if argv is None else argv
    args = ap.parse_args(argv)
    if not args.paths:
        args = ap.parse_args(config_args() + argv)
    args.paths = args.paths or ["."]
    if args.list_rules:
        for k, v in RULES.items():
            print(f"{k:9}{v}")
        return 0
    if args.checksum:
        print(self_checksum())
        return 0
    findings = []
    for path in collect(args.paths, DEFAULT_EXCLUDE_FILES + args.exclude):
        findings.extend(lint_file(path))
    for f in findings:
        print(f)
    counts = {}
    for f in findings:
        counts[f.rule] = counts.get(f.rule, 0) + 1
    summary = ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "clean"
    print(f"css-touch-lint: {len(findings)} finding(s): {summary}", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
