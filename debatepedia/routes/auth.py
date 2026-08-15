from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required, login_user, logout_user
from sqlalchemy import or_
from ..extensions import db
from ..models import User, Note, Submission

auth = Blueprint('auth', __name__, url_prefix='/api/auth')

def user_json(user):
    return {'id': user.id, 'username': user.username, 'email': user.email, 'role': user.role, 'isAdmin': user.is_admin}

@auth.get('/me')
def me():
    return jsonify({'user': user_json(current_user) if current_user.is_authenticated else None})

@auth.post('/register')
def register():
    data = request.get_json() or {}
    username = str(data.get('username','')).strip()
    email = str(data.get('email','')).strip().lower()
    password = str(data.get('password',''))
    if len(username) < 3 or len(username) > 80:
        return jsonify(error='Username must be 3–80 characters.'), 400
    if len(password) < 8:
        return jsonify(error='Password must be at least 8 characters.'), 400
    if '@' not in email:
        return jsonify(error='Enter a valid email address.'), 400
    if User.query.filter(or_(User.username.ilike(username), User.email.ilike(email))).first():
        return jsonify(error='That username or email is already registered.'), 409
    user = User(username=username, email=email, role='user')
    user.set_password(password)
    db.session.add(user); db.session.commit()
    login_user(user)
    return jsonify(user=user_json(user)), 201

@auth.post('/login')
def login():
    data = request.get_json() or {}
    identifier = str(data.get('identifier','')).strip()
    password = str(data.get('password',''))
    user = User.query.filter(or_(User.username.ilike(identifier), User.email.ilike(identifier.lower()))).first()
    if not user or not user.check_password(password):
        return jsonify(error='Invalid username/email or password.'), 401
    login_user(user, remember=False)
    return jsonify(user=user_json(user))

@auth.post('/logout')
def logout():
    logout_user()
    return jsonify(ok=True)

@auth.post('/account/delete')
@login_required
def delete_account():
    data = request.get_json() or {}
    password = str(data.get('password', ''))

    if not current_user.check_password(password):
        return jsonify(error='Incorrect password.'), 401

    if current_user.is_admin and User.query.filter_by(role='admin').count() <= 1:
        return jsonify(error="You're the only admin — promote another account to admin before deleting this one."), 400

    user_id = current_user.id

    # Keep published content, just detach it from the deleted account.
    Note.query.filter_by(author_id=user_id).update({'author_id': None})
    # Submissions are the review queue, not published content, so they're
    # removed outright rather than left orphaned (author_id is required there).
    Submission.query.filter_by(author_id=user_id).delete()
    Submission.query.filter_by(reviewer_id=user_id).update({'reviewer_id': None})

    user = db.session.get(User, user_id)
    logout_user()
    db.session.delete(user)
    db.session.commit()

    return jsonify(ok=True)
