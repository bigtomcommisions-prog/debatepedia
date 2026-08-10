import os


class Config:
    SECRET_KEY = os.environ.get(
        "SECRET_KEY",
        "change-me-in-production"
    )

    DATABASE_URL = os.environ.get("DATABASE_URL")

    if DATABASE_URL:
        SQLALCHEMY_DATABASE_URI = DATABASE_URL.replace(
            "postgres://",
            "postgresql://",
            1
        )
    else:
        SQLALCHEMY_DATABASE_URI = "sqlite:///debatepedia.db"

    SQLALCHEMY_TRACK_MODIFICATIONS = False
