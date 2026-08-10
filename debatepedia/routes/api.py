from datetime import datetime, timezone
from functools import wraps
import secrets
from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required
from ..extensions import db
from ..models import Note, Submission

api = Blueprint('api', __name__, url_prefix='/api')

def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapped(*args, **kwargs):
        if not current_user.is_admin:
            return jsonify(error='Administrator access required.'), 403
        return fn(*args, **kwargs)
    return wrapped

def uid(prefix):
    return f'{prefix}-{secrets.token_urlsafe(7).lower()}'

def parse_common(data, prefix=''):
    p = lambda key: data.get(prefix + key)
    tags = [x.strip() for x in str(p('tags') or '').split(',') if x.strip()] if isinstance(p('tags'), str) else (p('tags') or [])
    premises = p('premises') or []
    if isinstance(premises, str): premises = [x.strip() for x in premises.split('\n') if x.strip()]
    manual = p('manualValid')
    if manual in ('', 'auto', None): manual = None
    elif manual in ('true', True, 'valid'): manual = True
    else: manual = False
    return tags, premises, manual, p('conclusion'), p('manualNote')

@api.get('/vault')
def vault():
    notes = Note.query.filter_by(status='approved').all()
    return jsonify(notes=[n.to_dict() for n in notes])

@api.get('/submissions')
@login_required
def submissions():
    q = Submission.query.order_by(Submission.created_at.desc())
    if not current_user.is_admin:
        q = q.filter_by(author_id=current_user.id)
    return jsonify(submissions=[s.to_dict() for s in q.all()])

@api.post('/submissions')
@login_required
def create_submission():
    data = request.get_json() or {}
    typ = data.get('type')
    if typ not in ('new', 'edit'):
        return jsonify(error='Submission type must be new or edit.'), 400
    s = Submission(id=uid('s'), type=typ, status='pending', author_id=current_user.id, author=current_user.username)
    if typ == 'new':
        title = str(data.get('title','')).strip(); content = str(data.get('content','')).strip()
        if not title or not content: return jsonify(error='Title and content are required.'), 400
        s.kind = data.get('kind'); s.parent_id = data.get('parentId') or None; s.relation = data.get('relation') or None
        s.title = title; s.content = content
        s.tags, s.premises, s.manual_valid, s.conclusion, s.manual_note = parse_common(data)
    else:
        target = Note.query.filter_by(id=data.get('targetId'), status='approved').first()
        if not target: return jsonify(error='Target note not found.'), 404
        title = str(data.get('title','')).strip(); content = str(data.get('content','')).strip()
        if not title or not content: return jsonify(error='Title and content are required.'), 400
        s.target_id = target.id; s.proposed_title = title; s.proposed_content = content
        tags, premises, manual, conclusion, note = parse_common(data)
        s.proposed_tags = tags; s.proposed_premises = premises; s.proposed_manual_valid = manual
        s.proposed_conclusion = conclusion; s.proposed_manual_note = note
    db.session.add(s); db.session.commit()
    return jsonify(submission=s.to_dict()), 201

@api.post('/submissions/<sid>/approve')
@admin_required
def approve(sid):
    s = db.session.get(Submission, sid)
    if not s or s.status != 'pending': return jsonify(error='Pending submission not found.'), 404
    if s.type == 'edit':
        target = db.session.get(Note, s.target_id)
        if not target: return jsonify(error='Target note no longer exists.'), 404
        target.title = s.proposed_title; target.content = s.proposed_content; target.tags = s.proposed_tags
        if target.kind == 'argument':
            target.premises = s.proposed_premises; target.conclusion = s.proposed_conclusion
            target.manual_valid = s.proposed_manual_valid; target.manual_note = s.proposed_manual_note
        target.edited_at = datetime.now(timezone.utc)
    else:
        n = Note(id=uid('n'), kind=s.kind, parent_id=s.parent_id, relation=s.relation, title=s.title, content=s.content,
                 status='approved', author=s.author, author_id=s.author_id, tags_json=s.tags_json, premises_json=s.premises_json,
                 conclusion=s.conclusion, manual_valid=s.manual_valid, manual_note=s.manual_note)
        db.session.add(n)
    s.status = 'approved'; s.reviewer_id = current_user.id; s.reviewed_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify(ok=True)

@api.post('/submissions/<sid>/reject')
@admin_required
def reject(sid):
    s = db.session.get(Submission, sid)
    if not s or s.status != 'pending': return jsonify(error='Pending submission not found.'), 404
    data = request.get_json() or {}
    s.status = 'rejected'; s.reviewer_id = current_user.id; s.reviewed_at = datetime.now(timezone.utc)
    s.review_note = str(data.get('note','')).strip() or None
    db.session.commit()
    return jsonify(ok=True)
@api.delete('/notes/<note_id>')
@admin_required
def delete_note(note_id):
    note = db.session.get(Note, note_id)

    if not note:
        return jsonify(error='Note not found.'), 404

    # Don't allow deleting a note that has children.
    children = Note.query.filter_by(parent_id=note.id).first()
    if children:
        return jsonify(
            error='This note has child notes. Delete or move them first.'
        ), 409

    db.session.delete(note)
    db.session.commit()

    return jsonify(ok=True)
