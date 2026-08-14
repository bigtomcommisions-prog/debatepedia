"""
Watches data/imports/ for CSV files and imports each one into the notes
table as soon as it appears.

This only works while this script is running (e.g. on your own machine, or
a persistent server) -- it will NOT run automatically on Vercel, since
serverless functions don't stay alive to watch a folder. For a Vercel
deployment, use the POST /api/notes/import endpoint instead (admin only).

Usage:
    python scripts/watch_imports.py
    python scripts/watch_imports.py --once      # scan once and exit
    python scripts/watch_imports.py --interval 5  # poll every 5s (default 2s)

Processed files are moved to data/imports/processed/.
Files that fail entirely (e.g. not valid CSV) are moved to
data/imports/failed/ along with a .error.txt explaining why.
"""
import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

IMPORTS_DIR = ROOT / 'data' / 'imports'
PROCESSED_DIR = IMPORTS_DIR / 'processed'
FAILED_DIR = IMPORTS_DIR / 'failed'


def ensure_dirs():
    for d in (IMPORTS_DIR, PROCESSED_DIR, FAILED_DIR):
        d.mkdir(parents=True, exist_ok=True)


def timestamped(name):
    return f'{time.strftime("%Y%m%d-%H%M%S")}_{name}'


def process_file(path, app):
    from debatepedia.services.csv_import import import_notes_from_path

    print(f'[watch_imports] importing {path.name} ...')
    try:
        with app.app_context():
            summary = import_notes_from_path(path)
    except Exception as e:  # noqa: BLE001
        dest = FAILED_DIR / timestamped(path.name)
        shutil.move(str(path), dest)
        dest.with_suffix(dest.suffix + '.error.txt').write_text(str(e))
        print(f'[watch_imports] FAILED {path.name}: {e} -> moved to {dest}')
        return

    dest = PROCESSED_DIR / timestamped(path.name)
    shutil.move(str(path), dest)
    print(
        f'[watch_imports] done {path.name}: '
        f'{summary["inserted"]} inserted, {summary["updated"]} updated, '
        f'{len(summary["errors"])} row errors -> moved to {dest}'
    )
    if summary['errors']:
        error_log = dest.with_suffix(dest.suffix + '.errors.txt')
        error_log.write_text('\n'.join(summary['errors']))
        print(f'[watch_imports] row errors written to {error_log}')


def scan_once(app):
    csv_files = sorted(p for p in IMPORTS_DIR.glob('*.csv') if p.is_file())
    for path in csv_files:
        process_file(path, app)
    return len(csv_files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true', help='scan once and exit instead of polling forever')
    parser.add_argument('--interval', type=float, default=2.0, help='seconds between scans (default: 2)')
    args = parser.parse_args()

    ensure_dirs()

    from debatepedia import create_app
    app = create_app()

    print(f'[watch_imports] watching {IMPORTS_DIR} (drop a .csv file here)')
    if args.once:
        scan_once(app)
        return

    try:
        while True:
            scan_once(app)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print('\n[watch_imports] stopped.')


if __name__ == '__main__':
    main()
