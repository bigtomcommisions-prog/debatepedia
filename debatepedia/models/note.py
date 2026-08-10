from datetime import datetime, timezone
from ..extensions import db

class Note(db.Model):
    id = db.Column(db.String(80), primary_key=True)
    kind = db.Column(db.String(30), nullable=False)
    parent_id = db.Column(db.String(80), nullable=True, index=True)
    relation = db.Column(db.String(30), nullable=True)
    title = db.Column(db.String(255), nullable=False)
    content = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(30), nullable=False, default='approved', index=True)
    author = db.Column(db.String(120), nullable=False)
    author_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    edited_at = db.Column(db.DateTime(timezone=True), nullable=True)
    tags_json = db.Column(db.Text, nullable=False, default='[]')
    premises_json = db.Column(db.Text, nullable=False, default='[]')
    conclusion = db.Column(db.Text, nullable=True)
    manual_valid = db.Column(db.Boolean, nullable=True)
    manual_note = db.Column(db.Text, nullable=True)

    @property
    def tags(self):
        import json
        return json.loads(self.tags_json or '[]')

    @tags.setter
    def tags(self, value):
        import json
        self.tags_json = json.dumps(value or [])

    @property
    def premises(self):
        import json
        return json.loads(self.premises_json or '[]')

    @premises.setter
    def premises(self, value):
        import json
        self.premises_json = json.dumps(value or [])

    def to_dict(self):
        return {
            'id': self.id, 'kind': self.kind, 'parentId': self.parent_id,
            'relation': self.relation, 'title': self.title, 'content': self.content,
            'status': self.status, 'author': self.author, 'createdAt': int(self.created_at.timestamp()*1000),
            'editedAt': int(self.edited_at.timestamp()*1000) if self.edited_at else None,
            'tags': self.tags, 'premises': self.premises, 'conclusion': self.conclusion,
            'manualValid': self.manual_valid, 'manualNote': self.manual_note,
        }
