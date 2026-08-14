"""
Shared logic for importing Note rows from a CSV file.

The CSV is expected to have the same columns as the Note model:
id, kind, parent_id, relation, title, content, status, author, author_id,
created_at, edited_at, tags_json, premises_json, conclusion, manual_valid,
manual_note

Only `id`, `kind`, `title`, and `content` are required per row. Everything
else falls back to a sensible default. Rows are upserted: if a note with the
same id already exists it is updated in place, otherwise a new note is
created.

Used by both:
- scripts/watch_imports.py (local folder watcher)
- debatepedia/routes/api.py -> POST /api/notes/import (admin file upload)
"""
import csv
import io
import json
import re
from datetime import datetime, timezone

from ..extensions import db
from ..models import Note, User

REQUIRED_FIELDS = ('id', 'kind', 'title', 'content')


class RowError(Exception):
    """Raised for a single bad row; caught and recorded, not fatal."""


def _clean(value):
    if value is None:
        return None
    value = value.strip()
    return value if value != '' else None


def _parse_bool(value):
    value = _clean(value)
    if value is None:
        return None
    return value.lower() in ('true', 't', '1', 'yes')


def _parse_json_list(value):
    value = _clean(value)
    if value is None:
        return '[]'
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        raise RowError(f'invalid JSON: {value!r}')
    if not isinstance(parsed, list):
        raise RowError(f'expected a JSON list: {value!r}')
    return json.dumps(parsed)


_OFFSET_RE = re.compile(r'([+-]\d{2})$')


def _parse_dt(value):
    value = _clean(value)
    if value is None:
        return None
    normalized = _OFFSET_RE.sub(r'\1:00', value)
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        raise RowError(f'unparseable date: {value!r}')
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _resolve_author_id(raw_author_id, _cache={}):
    """Only keep author_id if that user actually exists, to satisfy the FK."""
    raw_author_id = _clean(raw_author_id)
    if raw_author_id is None:
        return None
    try:
        author_id = int(raw_author_id)
    except ValueError:
        return None
    if author_id not in _cache:
        _cache[author_id] = db.session.get(User, author_id) is not None
    return author_id if _cache[author_id] else None


def _apply_row(row, existing_by_id):
    row_id = _clean(row.get('id'))
    for field in REQUIRED_FIELDS:
        if _clean(row.get(field)) is None:
            raise RowError(f'missing required field "{field}"')

    kwargs = dict(
        kind=row['kind'].strip(),
        parent_id=_clean(row.get('parent_id')),
        relation=_clean(row.get('relation')),
        title=row['title'].strip(),
        content=row['content'],
        status=_clean(row.get('status')) or 'approved',
        author=_clean(row.get('author')) or 'unknown',
        author_id=_resolve_author_id(row.get('author_id')),
        created_at=_parse_dt(row.get('created_at')) or datetime.now(timezone.utc),
        edited_at=_parse_dt(row.get('edited_at')),
        tags_json=_parse_json_list(row.get('tags_json')),
        premises_json=_parse_json_list(row.get('premises_json')),
        conclusion=_clean(row.get('conclusion')),
        manual_valid=_parse_bool(row.get('manual_valid')),
        manual_note=_clean(row.get('manual_note')),
    )

    note = existing_by_id.get(row_id)
    if note is None:
        note = Note(id=row_id, **kwargs)
        db.session.add(note)
        existing_by_id[row_id] = note
        return 'inserted'
    else:
        for key, value in kwargs.items():
            setattr(note, key, value)
        return 'updated'


def import_notes_from_rows(rows):
    """
    rows: an iterable of dicts (e.g. from csv.DictReader).
    Returns a summary dict and rolls back entirely if nothing succeeded,
    but otherwise commits whatever validated cleanly and reports the rest
    as errors.
    """
    existing_by_id = {n.id: n for n in Note.query.all()}
    inserted = updated = 0
    errors = []

    for i, row in enumerate(rows, start=2):  # start=2: header is row 1
        try:
            result = _apply_row(row, existing_by_id)
            if result == 'inserted':
                inserted += 1
            else:
                updated += 1
        except RowError as e:
            errors.append(f'row {i} ({row.get("id", "?")}): {e}')
        except Exception as e:  # noqa: BLE001 - surface anything unexpected too
            errors.append(f'row {i} ({row.get("id", "?")}): unexpected error: {e}')

    if inserted or updated:
        db.session.commit()
    else:
        db.session.rollback()

    return {'inserted': inserted, 'updated': updated, 'errors': errors}


def import_notes_from_path(path):
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return import_notes_from_rows(reader)


def import_notes_from_stream(stream):
    """stream: a binary file-like object, e.g. Flask's request.files['file'].stream"""
    text_stream = io.TextIOWrapper(stream, encoding='utf-8', newline='')
    reader = csv.DictReader(text_stream)
    return import_notes_from_rows(reader)
