import os
from flask import Flask
from .extensions import db, login_manager
from .models import User
from .routes import main, auth, api
from .services.seed import seed_database
from config import Config


def create_app(config_class=Config):
    app = Flask(__name__, instance_relative_config=True)

    app.config.from_object(config_class)

    os.makedirs(app.instance_path, exist_ok=True)

    db.init_app(app)
    login_manager.init_app(app)

    app.register_blueprint(main)
    app.register_blueprint(auth)
    app.register_blueprint(api)

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    with app.app_context():
        db.create_all()
        seed_database()
        bootstrap_admin(app)

    return app


def bootstrap_admin(app):
    username = os.environ.get("ADMIN_USERNAME")
    email = os.environ.get("ADMIN_EMAIL")
    password = os.environ.get("ADMIN_PASSWORD")

    if not all([username, email, password]):
        return

    if User.query.filter_by(role="admin").first():
        return

    user = User(
        username=username,
        email=email.lower(),
        role="admin"
    )

    user.set_password(password)

    db.session.add(user)
    db.session.commit()
