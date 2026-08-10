import json
from pathlib import Path
from ..extensions import db
from ..models import Note, Submission


def seed_database():
    if Note.query.first():
        return
    data = json.loads((Path(__file__).resolve().parent.parent / 'seed.json').read_text())
    for raw in data['notes']:
        n = Note(
            id=raw['id'], kind=raw['kind'], parent_id=raw.get('parentId'), relation=raw.get('relation'),
            title=raw['title'], content=raw['content'], status=raw['status'], author=raw['author'],
            tags_json=json.dumps(raw.get('tags', [])), premises_json=json.dumps(raw.get('premises', [])),
            conclusion=raw.get('conclusion'), manual_valid=raw.get('manualValid'), manual_note=raw.get('manualNote')
        )
        db.session.add(n)
    # Seed submissions cannot be associated with a real account. They are intentionally omitted.
    db.session.commit()
