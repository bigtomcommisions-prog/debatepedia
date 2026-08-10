# Debatepedia — Flask edition

This version keeps the existing Debatepedia UI while moving persistence and community moderation to a Flask backend.

## Stack

- Flask
- Flask-SQLAlchemy
- Flask-Login
- SQLite by default
- PostgreSQL supported through `DATABASE_URL`
- Existing Debatepedia frontend split into templates, CSS, API/auth JS, and application JS

## Features

- Existing Vault / Graph / Community / Approved UI preserved
- User registration and login
- Secure password hashing
- `user` and `admin` roles
- Authenticated contribution submission
- Authenticated edit suggestions
- Server-side moderation permissions
- Admin approve/reject actions
- Persistent submission status and review metadata
- Seeded Debatepedia notes from the original prototype

## Local setup

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and set a strong `SECRET_KEY` plus the initial admin credentials. The project does not load `.env` automatically; export those variables in your shell or configure them in your hosting provider.

Then:

```bash
flask --app app run --debug
```

Open `http://127.0.0.1:5000`.

## First admin

Set these environment variables before the first run:

```text
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=use-a-strong-password
```

The first startup creates that account as an administrator. After that, changing the environment variables will not replace an existing admin.

## Production

GitHub Pages cannot run this Flask application. Keep the repository on GitHub and deploy the Flask app to a Python-capable host. For multi-user production use, set `DATABASE_URL` to PostgreSQL rather than relying on SQLite.

Set a strong random `SECRET_KEY` in the host environment and never commit real passwords or secrets.

## Architecture

```text
debatepedia/
├── app.py
├── config.py
├── requirements.txt
├── debatepedia/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── templates/
│   └── static/
└── instance/
    └── debatepedia.db
```

The browser no longer stores the vault or moderation queue. The Flask API is authoritative for notes, submissions, users, and permissions.
