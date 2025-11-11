"""
Flask-WTF forms for CSRF protection
"""
from flask_wtf import FlaskForm
from wtforms import PasswordField
from wtforms.validators import DataRequired, Length


class LoginForm(FlaskForm):
    """Login form with CSRF protection"""
    password = PasswordField('Password', validators=[
        DataRequired(message='Password is required'),
        Length(min=1, max=1000, message='Invalid password length')
    ])

    class Meta:
        csrf = True