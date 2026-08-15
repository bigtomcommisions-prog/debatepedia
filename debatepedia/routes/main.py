from flask import Blueprint, render_template

main = Blueprint('main', __name__)

@main.get('/')
def index():
    return render_template('index.html')

@main.get('/privacy')
def privacy():
    return render_template('privacy.html')

@main.get('/terms')
def terms():
    return render_template('terms.html')
