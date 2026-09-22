import os
import re
import sqlite3
import time
import uuid
from pathlib import Path

import jwt
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')
DB_PATH = BASE_DIR / 'app.sqlite'
DATABASE_URL = os.getenv('DATABASE_URL', '').strip()
JWT_SECRET = os.getenv('JWT_SECRET', 'murom-dev-secret-change-me')
ADMIN_EMAIL = os.getenv('ADMIN_EMAIL', '').strip().lower()
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', '')
IS_PRODUCTION = os.getenv('FLASK_ENV', '').lower() == 'production'
SEED_DEMO_DATA = os.getenv('SEED_DEMO_DATA', '0') == '1'
CORS_ORIGINS = [origin.strip() for origin in os.getenv('CORS_ORIGINS', '').split(',') if origin.strip()]
DAY_MS = 24 * 60 * 60 * 1000

if IS_PRODUCTION and (JWT_SECRET == 'murom-dev-secret-change-me' or not ADMIN_EMAIL or not ADMIN_PASSWORD):
    raise RuntimeError('ADMIN_EMAIL, ADMIN_PASSWORD and JWT_SECRET must be configured in production')

app = Flask(__name__, static_folder='.', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024

if CORS_ORIGINS:
    from flask_cors import CORS
    CORS(app, origins=CORS_ORIGINS)


@app.after_request
def add_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if IS_PRODUCTION:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response


class DatabaseConnection:
    def __init__(self, connection, is_postgres=False):
        self.connection = connection
        self.is_postgres = is_postgres

    def execute(self, query, params=()):
        if self.is_postgres:
            query = re.sub(r'\?', '%s', query)
        return self.connection.execute(query, params)

    def commit(self):
        return self.connection.commit()

    def close(self):
        return self.connection.close()

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return self.connection.__exit__(exc_type, exc_value, traceback)


def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        if DATABASE_URL:
            if psycopg is None:
                raise RuntimeError('DATABASE_URL is set but psycopg is not installed')
            connection = psycopg.connect(DATABASE_URL, row_factory=dict_row)
            db = DatabaseConnection(connection, is_postgres=True)
        else:
            connection = sqlite3.connect(DB_PATH)
            connection.row_factory = sqlite3.Row
            db = DatabaseConnection(connection)
        g._database = db
    return db


@app.teardown_appcontext
def close_db(_error):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()


def init_db():
    with app.app_context():
        with get_db() as conn:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    created_at INTEGER NOT NULL
                )
                '''
            )

            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS posts (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    life TEXT NOT NULL DEFAULT 'day'
                )
                '''
            )

            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS comments (
                    id TEXT PRIMARY KEY,
                    post_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                '''
            )

            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS post_likes (
                    post_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (post_id, user_id)
                )
                '''
            )

            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY,
                    post_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    reason TEXT DEFAULT '',
                    created_at INTEGER NOT NULL
                )
                '''
            )

            admin = conn.execute('SELECT id FROM users WHERE email = ?', (ADMIN_EMAIL,)).fetchone() if ADMIN_EMAIL else None
            if ADMIN_EMAIL and ADMIN_PASSWORD and admin is None:
                conn.execute(
                    '''
                    INSERT INTO users (id, name, email, password_hash, role, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ''',
                    (
                        str(uuid.uuid4()),
                        'Администратор',
                        ADMIN_EMAIL,
                        generate_password_hash(ADMIN_PASSWORD),
                        'admin',
                        int(time.time() * 1000),
                    ),
                )
            elif admin is not None and ADMIN_PASSWORD:
                conn.execute(
                    'UPDATE users SET role = ?, password_hash = ? WHERE email = ?',
                    ('admin', generate_password_hash(ADMIN_PASSWORD), ADMIN_EMAIL),
                )

            if ADMIN_EMAIL:
                conn.execute(
                    "UPDATE users SET role = 'user' WHERE role = 'admin' AND email != ?",
                    (ADMIN_EMAIL,),
                )

            if SEED_DEMO_DATA and conn.execute('SELECT COUNT(*) AS count FROM posts').fetchone()['count'] == 0 and ADMIN_EMAIL:
                admin_user = conn.execute('SELECT id FROM users WHERE email = ?', (ADMIN_EMAIL,)).fetchone()
                if admin_user is None:
                    conn.commit()
                    return
                now = int(time.time() * 1000)
                sample_posts = [
                    ('Куплю гитарный кабинет 2×12', 'Ищу кабинет под ламповую голову, желательно с динамиками Celestion. Самовывоз из центра.', now - 25 * 60 * 1000, now + DAY_MS),
                    ('Ищу напарника в Deep Rock Galactic', 'Вечера по будням, микрофон обязателен.', now - 2 * 60 * 60 * 1000, now + DAY_MS),
                    ('Отдам котят в добрые руки', 'Три котёнка, два месяца, к лотку приучены. Мальчик рыжий, девочки серая и пёстрая. Приезжайте знакомиться, отдаём бесплатно.', now - 10 * 60 * 60 * 1000, now + DAY_MS),
                    ('Продам велосипед', 'Горный, 26", состояние хорошее, недавно менял цепь.', now - 12 * 60 * 60 * 1000, now + DAY_MS),
                ]
                for title, text, created_at, expires_at in sample_posts:
                    conn.execute(
                        '''
                        INSERT INTO posts (id, user_id, title, text, created_at, expires_at, life)
                        VALUES (?, ?, ?, ?, ?, ?, 'day')
                        ''',
                        (str(uuid.uuid4()), admin_user['id'], title, text, created_at, expires_at),
                    )

            conn.commit()


def serialize_user(user):
    if not user:
        return None
    return {
        'id': user['id'],
        'name': user['name'],
        'email': user['email'],
        'role': user['role'],
    }


def current_user_or_none():
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None
    token = header.split(' ', 1)[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        user_id = payload['id']
        with get_db() as conn:
            user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        return user
    except Exception:
        return None


def auth_required(view):
    def wrapped(*args, **kwargs):
        user = current_user_or_none()
        if user is None:
            return jsonify({'message': 'Требуется авторизация'}), 401
        return view(*args, **kwargs, user=user)

    wrapped.__name__ = view.__name__
    return wrapped


def admin_required(view):
    def wrapped(*args, **kwargs):
        user = current_user_or_none()
        if user is None:
            return jsonify({'message': 'Требуется авторизация'}), 401
        if user['role'] != 'admin':
            return jsonify({'message': 'Доступ только для модератора'}), 403
        return view(*args, **kwargs, user=user)

    wrapped.__name__ = view.__name__
    return wrapped


def get_post_by_id(post_id, viewer_id=None):
    with get_db() as conn:
        post = conn.execute(
            '''
            SELECT p.*, u.name AS author, u.role AS author_role
            FROM posts p
            JOIN users u ON u.id = p.user_id
            WHERE p.id = ?
            ''',
            (post_id,),
        ).fetchone()
        if post is None:
            return None

        comments = conn.execute(
            '''
            SELECT c.*, u.name AS author
            FROM comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = ?
            ORDER BY c.created_at ASC
            ''',
            (post_id,),
        ).fetchall()

        like_count = conn.execute('SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?', (post_id,)).fetchone()
        liked = None
        if viewer_id:
            liked = conn.execute('SELECT 1 AS liked FROM post_likes WHERE post_id = ? AND user_id = ?', (post_id, viewer_id)).fetchone()
        report_count = conn.execute('SELECT COUNT(*) AS count FROM reports WHERE post_id = ?', (post_id,)).fetchone()

        return {
            'id': post['id'],
            'title': post['title'],
            'text': post['text'],
            'user_id': post['user_id'],
            'author': post['author'],
            'author_role': post['author_role'],
            'created_at': post['created_at'],
            'expires_at': post['expires_at'],
            'life': post['life'],
            'likes': int(like_count['count']) if like_count else 0,
            'liked': bool(liked and liked['liked']),
            'own': viewer_id == post['user_id'],
            'reported': int(report_count['count']) > 0 if report_count else False,
            'comments': [
                {
                    'id': comment['id'],
                    'author': comment['author'],
                    'text': comment['text'],
                    'created_at': comment['created_at'],
                    'user_id': comment['user_id'],
                    'own': viewer_id == comment['user_id'],
                }
                for comment in comments
            ],
        }


@app.get('/api/health')
def health():
    return jsonify({'ok': True, 'time': int(time.time() * 1000)})


@app.post('/api/auth/register')
def register():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not name or not email or not password:
        return jsonify({'message': 'Имя, email и пароль обязательны'}), 400
    if len(password) < 6:
        return jsonify({'message': 'Пароль должен быть не короче 6 символов'}), 400

    with get_db() as conn:
        existing = conn.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
        if existing is not None:
            return jsonify({'message': 'Пользователь с таким email уже существует'}), 409

        user_id = str(uuid.uuid4())
        conn.execute(
            '''
            INSERT INTO users (id, name, email, password_hash, role, created_at)
            VALUES (?, ?, ?, ?, 'user', ?)
            ''',
            (user_id, name, email, generate_password_hash(password), int(time.time() * 1000)),
        )
        user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        token = jwt.encode({'id': user['id'], 'email': user['email'], 'role': user['role']}, JWT_SECRET, algorithm='HS256')
        return jsonify({'token': token, 'user': serialize_user(user)}), 201


@app.post('/api/auth/login')
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not email or not password:
        return jsonify({'message': 'Email и пароль обязательны'}), 400

    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        if user is None or not check_password_hash(user['password_hash'], password):
            return jsonify({'message': 'Неверный email или пароль'}), 401

        token = jwt.encode({'id': user['id'], 'email': user['email'], 'role': user['role']}, JWT_SECRET, algorithm='HS256')
        return jsonify({'token': token, 'user': serialize_user(user)})


@app.get('/api/auth/me')
@auth_required
def me(user):
    return jsonify({'user': serialize_user(user)})


@app.get('/api/posts')
def list_posts():
    viewer = current_user_or_none()
    viewer_id = viewer['id'] if viewer else None
    search = (request.args.get('q') or '').strip().lower()
    now = int(time.time() * 1000)

    with get_db() as conn:
        sql = '''
            SELECT p.*, u.name AS author, u.role AS author_role
            FROM posts p
            JOIN users u ON u.id = p.user_id
            WHERE p.expires_at > ?
        '''
        params = [now]
        if search:
            sql += ' AND (LOWER(p.title) LIKE ? OR LOWER(p.text) LIKE ?)'
            params.extend([f'%{search}%', f'%{search}%'])
        sql += ' ORDER BY p.created_at DESC'
        posts = conn.execute(sql, params).fetchall()

        result = []
        for post in posts:
            comments = conn.execute(
                '''
                SELECT c.*, u.name AS author
                FROM comments c
                JOIN users u ON u.id = c.user_id
                WHERE c.post_id = ?
                ORDER BY c.created_at ASC
                ''',
                (post['id'],),
            ).fetchall()

            like_count = conn.execute('SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?', (post['id'],)).fetchone()
            liked = None
            if viewer_id:
                liked = conn.execute('SELECT 1 AS liked FROM post_likes WHERE post_id = ? AND user_id = ?', (post['id'], viewer_id)).fetchone()
            report_count = conn.execute('SELECT COUNT(*) AS count FROM reports WHERE post_id = ?', (post['id'],)).fetchone()

            result.append({
                'id': post['id'],
                'title': post['title'],
                'text': post['text'],
                'user_id': post['user_id'],
                'author': post['author'],
                'author_role': post['author_role'],
                'created_at': post['created_at'],
                'expires_at': post['expires_at'],
                'life': post['life'],
                'likes': int(like_count['count']) if like_count else 0,
                'liked': bool(liked and liked['liked']),
                'own': viewer_id == post['user_id'],
                'reported': bool(report_count and int(report_count['count']) > 0),
                'comments': [
                    {
                        'id': comment['id'],
                        'author': comment['author'],
                        'text': comment['text'],
                        'created_at': comment['created_at'],
                        'user_id': comment['user_id'],
                        'own': viewer_id == comment['user_id'],
                    }
                    for comment in comments
                ],
            })

    return jsonify({'posts': result})


@app.post('/api/posts')
@auth_required
def create_post(user):
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    text = (data.get('text') or '').strip()
    life = 'day'

    if not title:
        return jsonify({'message': 'Введите заголовок'}), 400
    if not text:
        return jsonify({'message': 'Введите текст объявления'}), 400

    with get_db() as conn:
        user_row = conn.execute('SELECT * FROM users WHERE id = ?', (user['id'],)).fetchone()
        now = int(time.time() * 1000)
        expires = now + DAY_MS
        post_id = str(uuid.uuid4())
        conn.execute(
            '''
            INSERT INTO posts (id, user_id, title, text, created_at, expires_at, life)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ''',
            (post_id, user['id'], title, text, now, expires, life),
        )
        conn.commit()
        conn.commit()
        post = get_post_by_id(post_id, user['id'])
        return jsonify({'post': post}), 201


@app.post('/api/posts/<post_id>/like')
@auth_required
def toggle_like(post_id, user):
    with get_db() as conn:
        existing = conn.execute('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', (post_id, user['id'])).fetchone()
        if existing:
            conn.execute('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', (post_id, user['id']))
        else:
            conn.execute('INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)', (post_id, user['id'], int(time.time() * 1000)))
        conn.commit()

    post = get_post_by_id(post_id, user['id'])
    return jsonify({'post': post})


@app.post('/api/posts/<post_id>/report')
@auth_required
def report_post(post_id, user):
    reason = (request.get_json(silent=True) or {}).get('reason', '')
    with get_db() as conn:
        existing = conn.execute('SELECT id FROM reports WHERE post_id = ? AND user_id = ?', (post_id, user['id'])).fetchone()
        if existing:
            return jsonify({'message': 'Жалоба уже отправлена', 'ok': True})
        conn.execute(
            'INSERT INTO reports (id, post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
            (str(uuid.uuid4()), post_id, user['id'], str(reason).strip(), int(time.time() * 1000)),
        )
        conn.commit()
    return jsonify({'message': 'Жалоба отмечена', 'ok': True})


@app.post('/api/posts/<post_id>/comments')
@auth_required
def create_comment(post_id, user):
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'message': 'Напишите комментарий'}), 400

    with get_db() as conn:
        conn.execute(
            'INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
            (str(uuid.uuid4()), post_id, user['id'], text, int(time.time() * 1000)),
        )
        conn.commit()

    post = get_post_by_id(post_id, user['id'])
    return jsonify({'post': post, 'comment': post['comments'][-1] if post['comments'] else None}), 201


@app.patch('/api/posts/<post_id>')
@auth_required
def edit_post(post_id, user):
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    text = (data.get('text') or '').strip()
    if not title or not text:
        return jsonify({'message': 'Заголовок и текст обязательны'}), 400

    with get_db() as conn:
        post = conn.execute('SELECT * FROM posts WHERE id = ?', (post_id,)).fetchone()
        if post is None:
            return jsonify({'message': 'Объявление не найдено'}), 404
        if post['user_id'] != user['id'] and user['role'] != 'admin':
            return jsonify({'message': 'Нельзя редактировать чужое объявление'}), 403
        conn.execute('UPDATE posts SET title = ?, text = ? WHERE id = ?', (title, text, post_id))
        conn.commit()

    return jsonify({'post': get_post_by_id(post_id, user['id'])})


@app.delete('/api/posts/<post_id>')
@auth_required
def delete_post(post_id, user):
    with get_db() as conn:
        post = conn.execute('SELECT * FROM posts WHERE id = ?', (post_id,)).fetchone()
        if post is None:
            return jsonify({'message': 'Объявление не найдено'}), 404
        if post['user_id'] != user['id'] and user['role'] != 'admin':
            return jsonify({'message': 'Нельзя удалять чужое объявление'}), 403

        conn.execute('DELETE FROM comments WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM post_likes WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM reports WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM posts WHERE id = ?', (post_id,))
        conn.commit()
    return jsonify({'ok': True})


@app.get('/api/mod/reports')
@admin_required
def mod_reports(user):
    with get_db() as conn:
        rows = conn.execute(
            '''
            SELECT r.*, p.title AS post_title, p.text AS post_text, p.user_id AS post_owner_id, u.name AS reporter_name
            FROM reports r
            JOIN posts p ON p.id = r.post_id
            JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
            '''
        ).fetchall()
    return jsonify({'reports': [dict(r) for r in rows]})


@app.delete('/api/mod/reports/<report_id>')
@admin_required
def dismiss_report(report_id, user):
    with get_db() as conn:
        conn.execute('DELETE FROM reports WHERE id = ?', (report_id,))
        conn.commit()
    return jsonify({'ok': True})


@app.delete('/api/mod/posts/<post_id>')
@admin_required
def admin_delete_post(post_id, user):
    with get_db() as conn:
        post = conn.execute('SELECT id FROM posts WHERE id = ?', (post_id,)).fetchone()
        if post is None:
            return jsonify({'message': 'Объявление уже удалено'}), 404
        conn.execute('DELETE FROM comments WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM post_likes WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM reports WHERE post_id = ?', (post_id,))
        conn.execute('DELETE FROM posts WHERE id = ?', (post_id,))
        conn.commit()
    return jsonify({'ok': True})


@app.delete('/api/mod/posts/<post_id>/comments/<comment_id>')
@admin_required
def admin_delete_comment(post_id, comment_id, user):
    with get_db() as conn:
        conn.execute('DELETE FROM comments WHERE id = ? AND post_id = ?', (comment_id, post_id))
        conn.commit()
    return jsonify({'ok': True})


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_index(path):
    if path.startswith('api/'):
        return jsonify({'message': 'API endpoint not found'}), 404
    if path and (Path(path).suffix or path.startswith('api')):
        return send_from_directory('.', path)
    return send_from_directory('.', 'index.html')


if __name__ == '__main__':
    init_db()
    app.run(
        host='0.0.0.0',
        port=int(os.getenv('PORT', 3000)),
        debug=os.getenv('FLASK_DEBUG', '0') == '1',
    )
