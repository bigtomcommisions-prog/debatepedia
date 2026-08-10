from datetime import datetime, timezone
from ..extensions import db

class Submission(db.Model):
    id = db.Column(db.String(80), primary_key=True)
    type = db.Column(db.String(20), nullable=False)  # new | edit
    kind = db.Column(db.String(30), nullable=True)
    parent_id = db.Column(db.String(80), nullable=True)
    relation = db.Column(db.String(30), nullable=True)
    target_id = db.Column(db.String(80), nullable=True)
    title = db.Column(db.String(255), nullable=True)
    content = db.Column(db.Text, nullable=True)
    tags_json = db.Column(db.Text, nullable=False, default='[]')
    premises_json = db.Column(db.Text, nullable=False, default='[]')
    conclusion = db.Column(db.Text, nullable=True)
    manual_valid = db.Column(db.Boolean, nullable=True)
    manual_note = db.Column(db.Text, nullable=True)
    proposed_title = db.Column(db.String(255), nullable=True)
    proposed_content = db.Column(db.Text, nullable=True)
    proposed_tags_json = db.Column(db.Text, nullable=False, default='[]')
    proposed_premises_json = db.Column(db.Text, nullable=False, default='[]')
    proposed_conclusion = db.Column(db.Text, nullable=True)
    proposed_manual_valid = db.Column(db.Boolean, nullable=True)
    proposed_manual_note = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(30), nullable=False, default='pending', index=True)
    author_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    author = db.Column(db.String(120), nullable=False)
    reviewer_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    review_note = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    reviewed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    @staticmethod
    def _load(value):
        import json
        return json.loads(value or '[]')

    @staticmethod
    def _dump(value):
        import json
        return json.dumps(value or [])

    @property
    def tags(self): return self._load(self.tags_json)
    @tags.setter
    def tags(self, v): self.tags_json = self._dump(v)
    @property
    def premises(self): return self._load(self.premises_json)
    @premises.setter
    def premises(self, v): self.premises_json = self._dump(v)
    @property
    def proposed_tags(self): return self._load(self.proposed_tags_json)
    @proposed_tags.setter
    def proposed_tags(self, v): self.proposed_tags_json = self._dump(v)
    @property
    def proposed_premises(self): return self._load(self.proposed_premises_json)
    @proposed_premises.setter
    def proposed_premises(self, v): self.proposed_premises_json = self._dump(v)

    def to_dict(self):
        return {
            'id': self.id, 'type': self.type, 'kind': self.kind, 'parentId': self.parent_id,
            'relation': self.relation, 'targetId': self.target_id, 'title': self.title,
            'content': self.content, 'tags': self.tags, 'premises': self.premises,
            'conclusion': self.conclusion, 'manualValid': self.manual_valid, 'manualNote': self.manual_note,
            'proposedTitle': self.proposed_title, 'proposedContent': self.proposed_content,
            'proposedTags': self.proposed_tags, 'proposedPremises': self.proposed_premises,
            'proposedConclusion': self.proposed_conclusion, 'proposedManualValid': self.proposed_manual_valid,
            'proposedManualNote': self.proposed_manual_note, 'status': self.status,
            'author': self.author, 'createdAt': int(self.created_at.timestamp()*1000),
            'reviewedAt': int(self.reviewed_at.timestamp()*1000) if self.reviewed_at else None,
        }
