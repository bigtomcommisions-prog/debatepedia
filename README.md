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

## Importing notes from CSV

There are two ways to bulk-import notes, both backed by the same import logic
in `debatepedia/services/csv_import.py`. The CSV needs these column headers
(matching the `Note` model): `id, kind, parent_id, relation, title, content,
status, author, author_id, created_at, edited_at, tags_json, premises_json,
conclusion, manual_valid, manual_note`. Only `id`, `kind`, `title`, and
`content` are required — everything else falls back to a default. Rows are
upserted, so re-importing a file with the same ids updates those notes rather
than duplicating them.

### Option A — drop a file in a folder (local only)

Run the watcher alongside the app on your own machine:

```bash
python scripts/watch_imports.py
```

Any `.csv` file dropped into `data/imports/` is imported automatically within
a couple of seconds, then moved to `data/imports/processed/` (or
`data/imports/failed/` with an `.error.txt` if it couldn't be read at all;
row-level problems are logged to a `.errors.txt` next to the processed file
instead of blocking the rest of the import).

Note: this only works while the watcher script is running. It will **not**
run automatically once deployed to Vercel, since serverless functions don't
stay alive to watch a folder — use Option B there instead.

### Option B — admin upload endpoint (works locally and on Vercel)

```bash
curl -X POST https://your-deployment/api/notes/import \
  -H "Cookie: <your admin session cookie>" \
  -F "file=@notes.csv"
```

Requires being logged in as an admin. Returns a JSON summary:
`{"inserted": N, "updated": N, "errors": [...]}`.

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
