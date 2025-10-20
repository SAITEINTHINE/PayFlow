import base64
import os
import io
import csv
import re
from datetime import datetime, date, timedelta
from flask import Flask, render_template, request, redirect, url_for, session, jsonify, send_file, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text

_FALLBACK_FAVICON = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQ4jWNgGAWjYBSMglEwCkbBUDAqRgUj4P///58BqYJRMArGgFDy0QAA2C4MxVQXJxYAAAAASUVORK5CYII='
)

def create_app():
    app = Flask(__name__)
    app.secret_key = os.getenv('SECRET_KEY', 'your-secret-key')
    # Ensure JSON responses keep Unicode characters such as Japanese intact
    app.config['JSON_AS_ASCII'] = False

    # --- Database Configuration ---
    # Prefer DATABASE_URL (Render/Heroku), otherwise use SQLite.
    database_url = os.getenv('DATABASE_URL', 'sqlite:///db.sqlite3')

    # Normalize old Heroku URL scheme: postgres:// -> postgresql://
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)

    # When Postgres is configured we must have psycopg2 available
    if database_url.startswith('postgresql://'):
        try:
            import psycopg2  # noqa: F401 - ensure driver is available
        except Exception as exc:
            raise RuntimeError(
                "DATABASE_URL is configured for Postgres but the psycopg2 driver is missing. "
                "Add 'psycopg2-binary' to your requirements."
            ) from exc

    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    db = SQLAlchemy(app)

    # --- Models ---
    class User(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(150), unique=True, nullable=False)
        email = db.Column(db.String(150), unique=True, nullable=True)
        password = db.Column(db.Text, nullable=False)
        shifts = db.relationship('Shift', backref='user', lazy=True, cascade='all, delete-orphan')
        jobs = db.relationship('Job', backref='user', lazy=True, cascade='all, delete-orphan')
        expenses = db.relationship('Expense', backref='user', lazy=True, cascade='all, delete-orphan')
        receipts = db.relationship('Receipt', backref='user', lazy=True, cascade='all, delete-orphan')

    class Job(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(150), nullable=False)
        hourly_wage = db.Column(db.Float, nullable=False, default=0.0)
        currency = db.Column(db.String(10), nullable=False, default='¥')
        color = db.Column(db.String(20), nullable=False, default='#4f46e5')
        user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
        shifts = db.relationship('Shift', backref='job', lazy=True)

    class Shift(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        date = db.Column(db.String(50))
        shift_type = db.Column(db.String(50))
        start_time = db.Column(db.String(10))
        end_time = db.Column(db.String(10))
        break_start = db.Column(db.String(10))
        break_end = db.Column(db.String(10))
        total_hours = db.Column(db.String(10))
        hourly_wage = db.Column(db.String(10))
        currency = db.Column(db.String(10))
        total_wage = db.Column(db.String(10))
        job_id = db.Column(db.Integer, db.ForeignKey('job.id'), nullable=True)
        user_id = db.Column(db.Integer, db.ForeignKey('user.id'))

    class Expense(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        date = db.Column(db.String(50), nullable=False)
        category = db.Column(db.String(100), nullable=False)
        amount = db.Column(db.Float, nullable=False, default=0.0)
        description = db.Column(db.String(255))
        user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

    class Budget(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        month = db.Column(db.String(7), nullable=False)  # YYYY-MM
        category = db.Column(db.String(100), nullable=False)
        amount = db.Column(db.Float, nullable=False, default=0.0)
        user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

    class Receipt(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(150))
        date = db.Column(db.String(50))
        subtotal = db.Column(db.Float, default=0.0)
        tax_total = db.Column(db.Float, default=0.0)
        grand_total = db.Column(db.Float, default=0.0)
        note = db.Column(db.Text, default='', server_default='')
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
        items = db.relationship('ReceiptItem', backref='receipt', lazy=True, cascade='all, delete-orphan')
        # legacy columns retained for backward compatibility
        filename = db.Column(db.String(255), nullable=False, default='receipt', server_default='receipt')
        mime_type = db.Column(db.String(50), nullable=False, default='', server_default='')
        image_data = db.Column(db.Text, default='', server_default='')
        ocr_text = db.Column(db.Text, default='', server_default='')
        suggested_category = db.Column(db.String(100), default='', server_default='')
        suggested_amount = db.Column(db.Float, default=0.0, server_default='0')

    class ReceiptItem(db.Model):
        id = db.Column(db.Integer, primary_key=True)
        date = db.Column(db.String(50))
        category = db.Column(db.String(50))
        description = db.Column(db.String(200))
        quantity = db.Column(db.Integer, default=1)
        unit_price = db.Column(db.Float, default=0.0)
        tax_rate = db.Column(db.Float, default=0.0)
        line_total = db.Column(db.Float, default=0.0)
        receipt_id = db.Column(db.Integer, db.ForeignKey('receipt.id'))

    # --- Routes ---

    @app.route('/')
    def index():
        if 'user_id' in session:
             # You can pass username to index.html if you display it
            return render_template('index.html', username=session.get('username'))
        return redirect(url_for('login'))

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if request.method == 'POST':
            username = request.form['username'].strip()
            password = request.form['password']
            user = User.query.filter_by(username=username).first()
            if user and check_password_hash(user.password, password):
                session['user_id'] = user.id
                session['username'] = user.username
                session['email'] = user.email
                return redirect(url_for('index'))
            return render_template('login.html', error="Invalid credentials")
        return render_template('login.html')

    @app.route('/signup', methods=['GET', 'POST'])
    def signup():
        if request.method == 'POST':
            username = request.form['username'].strip()
            email = (request.form.get('email') or '').strip() or None
            password = request.form['password']
            if not username or not password:
                return render_template('signup.html', error="Username and password are required")
            if User.query.filter_by(username=username).first():
                return render_template('signup.html', error="Username already exists")
            if email and User.query.filter_by(email=email).first():
                return render_template('signup.html', error="Email already exists")
            new_user = User(username=username, email=email, password=generate_password_hash(password))
            db.session.add(new_user)
            db.session.commit()
            return redirect(url_for('login'))
        return render_template('signup.html')

    @app.route('/logout')
    def logout():
        session.pop('user_id', None)
        session.pop('username', None)
        session.pop('email', None)
        return redirect(url_for('login'))

    @app.route('/profile')
    def profile():
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = User.query.get(session['user_id'])
        return render_template('profile.html', user=user)

    @app.route('/api/shifts', methods=['GET', 'POST'])
    def api_shifts():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        if request.method == 'POST':
            data = request.get_json() or {}
            job_id = data.get('job_id')
            job = None
            if job_id is not None:
                try:
                    job_id = int(job_id)
                except (TypeError, ValueError):
                    return jsonify({'error': 'Invalid job id'}), 400
                job = Job.query.filter_by(id=job_id, user_id=session['user_id']).first()
                if not job:
                    return jsonify({'error': 'Invalid job assignment'}), 400

            new_shift = Shift(
                date=data.get('date', ''),
                shift_type=data.get('shift_type', ''),
                start_time=data.get('start_time', ''),
                end_time=data.get('end_time', ''),
                break_start=data.get('break_start', ''),
                break_end=data.get('break_end', ''),
                total_hours=data.get('total_hours', ''),
                hourly_wage=data.get('hourly_wage', ''),
                currency=data.get('currency', ''),
                total_wage=data.get('total_wage', ''),
                job_id=job.id if job else None,
                user_id=session['user_id']
            )
            db.session.add(new_shift)
            db.session.commit()
            return jsonify({'success': True, 'id': new_shift.id})
        else:
            shifts = Shift.query.filter_by(user_id=session['user_id']).all()
            return jsonify([{
                'id': s.id,
                'date': s.date,
                'shift_type': s.shift_type,
                'start_time': s.start_time,
                'end_time': s.end_time,
                'break_start': s.break_start,
                'break_end': s.break_end,
                'total_hours': s.total_hours,
                'hourly_wage': s.hourly_wage,
                'currency': s.currency,
                'total_wage': s.total_wage,
                'job_id': s.job_id,
                'job_name': s.job.name if s.job else None,
                'job_color': s.job.color if s.job else None
            } for s in shifts])

    @app.route('/api/shifts/<int:shift_id>', methods=['DELETE'])
    def delete_shift(shift_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        shift = Shift.query.filter_by(id=shift_id, user_id=session['user_id']).first()
        if not shift:
            return jsonify({'error': 'Shift not found'}), 404
        db.session.delete(shift)
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/jobs', methods=['GET', 'POST'])
    def api_jobs():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        if request.method == 'POST':
            data = request.get_json() or {}
            name = (data.get('name') or '').strip()
            try:
                hourly_wage = float(data.get('hourly_wage', 0))
            except (TypeError, ValueError):
                hourly_wage = 0.0
            currency = (data.get('currency') or '').strip() or '¥'
            color = (data.get('color') or '').strip() or '#4f46e5'

            if not name:
                return jsonify({'error': 'Job name required'}), 400

            new_job = Job(
                name=name,
                hourly_wage=hourly_wage,
                currency=currency,
                color=color,
                user_id=session['user_id']
            )
            db.session.add(new_job)
            db.session.commit()
            return jsonify({
                'success': True,
                'job': {
                    'id': new_job.id,
                    'name': new_job.name,
                    'hourly_wage': new_job.hourly_wage,
                    'currency': new_job.currency,
                    'color': new_job.color
                }
            }), 201

        jobs = Job.query.filter_by(user_id=session['user_id']).order_by(Job.name.asc()).all()
        return jsonify([{
            'id': j.id,
            'name': j.name,
            'hourly_wage': j.hourly_wage,
            'currency': j.currency,
            'color': j.color or '#4f46e5'
        } for j in jobs])

    @app.route('/api/jobs/<int:job_id>', methods=['DELETE'])
    def delete_job(job_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        job = Job.query.filter_by(id=job_id, user_id=session['user_id']).first()
        if not job:
            return jsonify({'error': 'Job not found'}), 404

        Shift.query.filter_by(job_id=job.id, user_id=session['user_id']).update({'job_id': None})
        db.session.delete(job)
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/expenses', methods=['GET', 'POST'])
    def api_expenses():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        if request.method == 'POST':
            data = request.get_json() or {}
            date = (data.get('date') or '').strip()
            category = (data.get('category') or '').strip() or 'General'
            description = (data.get('description') or '').strip()
            try:
                amount = float(data.get('amount', 0))
            except (TypeError, ValueError):
                amount = 0.0

            if not date or amount <= 0:
                return jsonify({'error': 'Date and positive amount are required'}), 400

            expense = Expense(
                date=date,
                category=category,
                amount=amount,
                description=description,
                user_id=session['user_id']
            )
            db.session.add(expense)
            db.session.commit()
            return jsonify({'success': True, 'id': expense.id}), 201

        expenses = Expense.query.filter_by(user_id=session['user_id']).order_by(Expense.date.desc()).all()
        return jsonify([{
            'id': e.id,
            'date': e.date,
            'category': e.category,
            'amount': e.amount,
            'description': e.description
        } for e in expenses])

    @app.route('/api/expenses/<int:expense_id>', methods=['DELETE'])
    def delete_expense(expense_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        expense = Expense.query.filter_by(id=expense_id, user_id=session['user_id']).first()
        if not expense:
            return jsonify({'error': 'Expense not found'}), 404
        db.session.delete(expense)
        db.session.commit()
        return jsonify({'success': True})

    def _validate_email_format(value):
        if not value:
            return False
        return bool(re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', value))

    @app.route('/account/change_email', methods=['POST'])
    def change_email():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        data = request.get_json() or {}
        new_email = (data.get('new_email') or '').strip()
        current_password = data.get('current_password') or ''
        user = User.query.get(session['user_id'])
        if not user:
            return jsonify({'error': 'User not found'}), 404
        if not check_password_hash(user.password, current_password):
            return jsonify({'error': 'Current password is incorrect'}), 400
        if not _validate_email_format(new_email):
            return jsonify({'error': 'Invalid email format'}), 400
        email_exists = User.query.filter(User.email == new_email, User.id != user.id).first()
        if email_exists:
            return jsonify({'error': 'Email already in use'}), 400
        user.email = new_email
        db.session.commit()
        session['email'] = user.email
        return jsonify({'success': True})

    @app.route('/account/change_password', methods=['POST'])
    def change_password():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        data = request.get_json() or {}
        current_password = data.get('current_password') or ''
        new_password = data.get('new_password') or ''
        confirm_password = data.get('confirm_password') or ''
        user = User.query.get(session['user_id'])
        if not user:
            return jsonify({'error': 'User not found'}), 404
        if not check_password_hash(user.password, current_password):
            return jsonify({'error': 'Current password is incorrect'}), 400
        if len(new_password) < 8:
            return jsonify({'error': 'Password must be at least 8 characters'}), 400
        if new_password != confirm_password:
            return jsonify({'error': 'Passwords do not match'}), 400
        user.password = generate_password_hash(new_password)
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/budgets', methods=['GET', 'POST'])
    def api_budgets():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        if request.method == 'POST':
            data = request.get_json() or {}
            month = (data.get('month') or '').strip()
            category = (data.get('category') or '').strip()
            try:
                amount = float(data.get('amount', 0))
            except (TypeError, ValueError):
                amount = 0.0

            if not month:
                month = datetime.utcnow().strftime('%Y-%m')
            if not category:
                return jsonify({'error': 'Category required'}), 400
            if amount < 0:
                return jsonify({'error': 'Amount must be non-negative'}), 400

            existing = Budget.query.filter_by(
                user_id=session['user_id'],
                month=month,
                category=category
            ).first()
            if existing:
                existing.amount = amount
                db.session.commit()
                budget = existing
            else:
                budget = Budget(
                    month=month,
                    category=category,
                    amount=amount,
                    user_id=session['user_id']
                )
                db.session.add(budget)
                db.session.commit()

            return jsonify({
                'id': budget.id,
                'month': budget.month,
                'category': budget.category,
                'amount': budget.amount
            })

        month = (request.args.get('month') or '').strip()
        if not month:
            month = datetime.utcnow().strftime('%Y-%m')
        budgets = Budget.query.filter_by(user_id=session['user_id'], month=month).all()
        return jsonify([{
            'id': b.id,
            'month': b.month,
            'category': b.category,
            'amount': b.amount
        } for b in budgets])

    @app.route('/api/budgets/<int:budget_id>', methods=['DELETE'])
    def delete_budget(budget_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        budget = Budget.query.filter_by(id=budget_id, user_id=session['user_id']).first()
        if not budget:
            return jsonify({'error': 'Budget not found'}), 404
        db.session.delete(budget)
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/receipts', methods=['GET', 'POST'])
    def api_receipts():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        if request.method == 'POST':
            data = request.get_json() or {}
            title = (data.get('title') or '').strip()
            receipt_date = (data.get('date') or '').strip()
            note = (data.get('note') or '').strip()
            items_data = data.get('items') or []

            if not items_data:
                return jsonify({'error': 'At least one line item is required'}), 400

            def parse_decimal(value, default=0.0):
                try:
                    return float(value)
                except (TypeError, ValueError):
                    return default

            def parse_int(value, default=0):
                try:
                    return int(value)
                except (TypeError, ValueError):
                    return default

            subtotal = 0.0
            tax_total = 0.0
            receipt_items = []
            for raw_item in items_data:
                quantity = parse_int(raw_item.get('quantity'), 1)
                quantity = max(quantity, 0)
                unit_price = parse_decimal(raw_item.get('unit_price'), 0.0)
                tax_rate = parse_decimal(raw_item.get('tax_rate'), 0.0)
                line_base = quantity * unit_price
                line_tax = line_base * (tax_rate / 100.0)
                line_total = line_base + line_tax
                subtotal += line_base
                tax_total += line_tax
                receipt_items.append({
                    'date': (raw_item.get('date') or '').strip(),
                    'category': (raw_item.get('category') or '').strip(),
                    'description': (raw_item.get('description') or '').strip(),
                    'quantity': quantity,
                    'unit_price': unit_price,
                    'tax_rate': tax_rate,
                    'line_total': line_total
                })

            receipt = Receipt(
                title=title,
                date=receipt_date,
                subtotal=subtotal,
                tax_total=tax_total,
                grand_total=subtotal + tax_total,
                note=note,
                user_id=session['user_id'],
                filename=(title or 'receipt'),
                mime_type='',
                image_data='',
                ocr_text='',
                suggested_category='',
                suggested_amount=0.0
            )
            db.session.add(receipt)
            db.session.flush()
            for item in receipt_items:
                db.session.add(ReceiptItem(
                    date=item['date'],
                    category=item['category'],
                    description=item['description'],
                    quantity=item['quantity'],
                    unit_price=item['unit_price'],
                    tax_rate=item['tax_rate'],
                    line_total=item['line_total'],
                    receipt_id=receipt.id
                ))
            db.session.commit()
            return jsonify({'success': True, 'id': receipt.id}), 201

        receipts = Receipt.query.filter_by(user_id=session['user_id']).order_by(Receipt.created_at.desc()).all()
        return jsonify([{
            'id': r.id,
            'title': r.title,
            'date': r.date,
            'subtotal': r.subtotal,
            'tax_total': r.tax_total,
            'grand_total': r.grand_total,
            'note': r.note or '',
            'created_at': r.created_at.isoformat(),
            'items': [{
                'id': item.id,
                'date': item.date,
                'category': item.category,
                'description': item.description,
                'quantity': item.quantity,
                'unit_price': item.unit_price,
                'tax_rate': item.tax_rate,
                'line_total': item.line_total
            } for item in r.items]
        } for r in receipts])

    @app.route('/api/receipts/<int:receipt_id>/pdf')
    def api_receipt_pdf(receipt_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        receipt = Receipt.query.filter_by(id=receipt_id, user_id=session['user_id']).first()
        if not receipt:
            return jsonify({'error': 'Receipt not found'}), 404
        return jsonify({
            'id': receipt.id,
            'title': receipt.title,
            'date': receipt.date,
            'subtotal': receipt.subtotal,
            'tax_total': receipt.tax_total,
            'grand_total': receipt.grand_total,
            'note': receipt.note or '',
            'created_at': receipt.created_at.isoformat(),
            'items': [{
                'id': item.id,
                'date': item.date,
                'category': item.category,
                'description': item.description,
                'quantity': item.quantity,
                'unit_price': item.unit_price,
                'tax_rate': item.tax_rate,
                'line_total': item.line_total
            } for item in receipt.items]
        })

    @app.route('/api/receipts/<int:receipt_id>', methods=['DELETE'])
    def delete_receipt(receipt_id):
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401
        receipt = Receipt.query.filter_by(id=receipt_id, user_id=session['user_id']).first()
        if not receipt:
            return jsonify({'error': 'Receipt not found'}), 404
        db.session.delete(receipt)
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/report')
    def api_report():
        if 'user_id' not in session:
            return jsonify({'error': 'Not logged in'}), 401

        start_raw = request.args.get('start')
        end_raw = request.args.get('end')
        job_ids_raw = request.args.get('job_ids')

        job_ids = []
        if job_ids_raw:
            try:
                job_ids = [int(jid) for jid in job_ids_raw.split(',') if jid.strip()]
            except ValueError:
                job_ids = []

        def parse_date(value):
            if not value:
                return None
            for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
                try:
                    return datetime.strptime(value, fmt).date()
                except ValueError:
                    continue
            return None

        start_date = parse_date(start_raw)
        end_date = parse_date(end_raw)
        today = date.today()
        week_start = today - timedelta(days=today.weekday())
        month_start = today.replace(day=1)
        year_start = today.replace(month=1, day=1)
        period_starts = {
            'week': week_start,
            'month': month_start,
            'year': year_start,
        }
        period_totals = {
            key: {'income': 0.0, 'expense': 0.0}
            for key in period_starts
        }

        def in_selected_range(dt_value):
            if dt_value is None:
                return not (start_date or end_date)
            if start_date and dt_value < start_date:
                return False
            if end_date and dt_value > end_date:
                return False
            return True

        def apply_period_income(amount, dt_value):
            if dt_value is None or dt_value > today:
                return
            for key, threshold in period_starts.items():
                if dt_value >= threshold:
                    period_totals[key]['income'] += amount

        def apply_period_expense(amount, dt_value):
            if dt_value is None or dt_value > today:
                return
            for key, threshold in period_starts.items():
                if dt_value >= threshold:
                    period_totals[key]['expense'] += amount

        shift_query = Shift.query.filter_by(user_id=session['user_id'])
        if job_ids:
            shift_query = shift_query.filter(Shift.job_id.in_(job_ids))
        all_shifts = shift_query.all()

        income_total = 0.0
        by_job = {}
        filtered_shifts = []
        for s in all_shifts:
            shift_date = parse_date(s.date)
            try:
                wage = float(s.total_wage or 0)
            except (TypeError, ValueError):
                wage = 0.0
            apply_period_income(wage, shift_date)
            if not in_selected_range(shift_date):
                continue
            income_total += wage
            filtered_shifts.append(s)
            job_name = s.job.name if s.job else 'Unassigned'
            by_job[job_name] = by_job.get(job_name, 0.0) + wage

        expense_query = Expense.query.filter_by(user_id=session['user_id'])
        all_expenses = expense_query.all()
        expense_total = 0.0
        by_category = {}
        filtered_expenses = []
        for e in all_expenses:
            expense_date = parse_date(e.date)
            amount = float(e.amount or 0)
            apply_period_expense(amount, expense_date)
            if not in_selected_range(expense_date):
                continue
            expense_total += amount
            filtered_expenses.append(e)
            by_category[e.category] = by_category.get(e.category, 0.0) + amount

        for key in period_totals:
            period = period_totals[key]
            period['net'] = period['income'] - period['expense']

        return jsonify({
            'income_total': income_total,
            'expense_total': expense_total,
            'net': income_total - expense_total,
            'by_job': by_job,
            'by_category': by_category,
            'periods': period_totals
        })

    @app.route('/api/export')
    def export_csv():
        if 'user_id' not in session:
            return redirect(url_for('login'))
        shifts = Shift.query.filter_by(user_id=session['user_id']).all()

        si = io.StringIO()
        cw = csv.writer(si)
        cw.writerow(['Date', 'Job', 'Shift Type', 'Start', 'End', 'Break Start', 'Break End',
                     'Total Hours', 'Hourly Wage', 'Currency', 'Total Wage'])
        for s in shifts:
            job_name = s.job.name if s.job else ''
            cw.writerow([
                s.date,
                job_name,
                s.shift_type,
                s.start_time,
                s.end_time,
                s.break_start,
                s.break_end,
                s.total_hours,
                s.hourly_wage,
                s.currency,
                s.total_wage
            ])

        mem = io.BytesIO()
        mem.write(si.getvalue().encode('utf-8'))
        mem.seek(0)
        return send_file(
            mem,
            mimetype='text/csv; charset=utf-8',
            as_attachment=True,
            download_name='my_shifts.csv'
        )

    # Health check (optional for Render)
    @app.route('/health')
    def health():
        return 'ok', 200

    with app.app_context():
        db.create_all()
        inspector = inspect(db.engine)
        if 'shift' in inspector.get_table_names():
            shift_columns = {col['name'] for col in inspector.get_columns('shift')}
            if 'job_id' not in shift_columns:
                with db.engine.connect() as conn:
                    conn.execute(text('ALTER TABLE shift ADD COLUMN job_id INTEGER'))
                    conn.commit()
        if 'job' in inspector.get_table_names():
            job_columns = {col['name'] for col in inspector.get_columns('job')}
            if 'color' not in job_columns:
                with db.engine.connect() as conn:
                    conn.execute(text("ALTER TABLE job ADD COLUMN color VARCHAR(20) DEFAULT '#4f46e5'"))
                    conn.commit()
        if 'user' in inspector.get_table_names():
            user_columns = inspector.get_columns('user')
            user_column_names = {col['name'] for col in user_columns}
            if 'email' not in user_column_names:
                try:
                    with db.engine.connect() as conn:
                        conn.execute(text('ALTER TABLE "user" ADD COLUMN email VARCHAR(150)'))
                        conn.commit()
                except Exception as exc:
                    print(f"[WARN] Unable to add email column to user table: {exc}")
            password_column = next((col for col in user_columns if col['name'] == 'password'), None)
            if password_column:
                password_type = str(password_column.get('type', '')).lower()
                if 'text' not in password_type:
                    try:
                        with db.engine.connect() as conn:
                            conn.execute(text('ALTER TABLE "user" ALTER COLUMN password TYPE TEXT'))
                            conn.commit()
                    except Exception as exc:
                        print(f"[WARN] Unable to widen user.password column: {exc}")
        if 'receipt' in inspector.get_table_names():
            receipt_columns = {col['name'] for col in inspector.get_columns('receipt')}
            column_defs = {
                'title': "ALTER TABLE receipt ADD COLUMN title VARCHAR(150)",
                'date': "ALTER TABLE receipt ADD COLUMN date VARCHAR(50)",
                'subtotal': "ALTER TABLE receipt ADD COLUMN subtotal FLOAT DEFAULT 0",
                'tax_total': "ALTER TABLE receipt ADD COLUMN tax_total FLOAT DEFAULT 0",
                'grand_total': "ALTER TABLE receipt ADD COLUMN grand_total FLOAT DEFAULT 0",
                'note': "ALTER TABLE receipt ADD COLUMN note TEXT DEFAULT ''"
            }
            for col_name, ddl in column_defs.items():
                if col_name not in receipt_columns:
                    try:
                        with db.engine.connect() as conn:
                            conn.execute(text(ddl))
                            conn.commit()
                    except Exception as exc:
                        print(f"[WARN] Unable to add column '{col_name}' to receipt table: {exc}")
            try:
                with db.engine.connect() as conn:
                    conn.execute(text("UPDATE receipt SET filename = COALESCE(filename, 'receipt')"))
                    conn.execute(text("UPDATE receipt SET mime_type = COALESCE(mime_type, '')"))
                    conn.execute(text("UPDATE receipt SET image_data = COALESCE(image_data, '')"))
                    conn.execute(text("UPDATE receipt SET ocr_text = COALESCE(ocr_text, '')"))
                    conn.execute(text("UPDATE receipt SET suggested_category = COALESCE(suggested_category, '')"))
                    conn.execute(text("UPDATE receipt SET suggested_amount = COALESCE(suggested_amount, 0)"))
                    conn.execute(text("UPDATE receipt SET note = COALESCE(note, '')"))
                    conn.commit()
            except Exception as exc:
                print(f"[WARN] Unable to normalize legacy receipt columns: {exc}")

    # Expose db and models if needed elsewhere
    app.db = db
    app.User = User
    app.Shift = Shift
    app.Job = Job
    app.Expense = Expense
    app.Budget = Budget
    app.Receipt = Receipt
    app.ReceiptItem = ReceiptItem
    return app


app = create_app()


@app.route('/favicon.ico')
def favicon():
    static_dir = os.path.join(app.root_path, 'static')
    ico_path = os.path.join(static_dir, 'favicon.ico')
    if os.path.exists(ico_path):
        return send_from_directory(static_dir, 'favicon.ico', mimetype='image/vnd.microsoft.icon')
    fallback = 'generated-icon.png'
    fallback_path = os.path.join(static_dir, fallback)
    if os.path.exists(fallback_path):
        return send_from_directory(static_dir, fallback, mimetype='image/png')
    return send_file(io.BytesIO(_FALLBACK_FAVICON), mimetype='image/png')


@app.route('/manifest.webmanifest')
def manifest():
    static_dir = os.path.join(app.root_path, 'static')
    return send_from_directory(static_dir, 'manifest.webmanifest', mimetype='application/manifest+json')


@app.route('/sw.js')
def service_worker():
    static_dir = os.path.join(app.root_path, 'static')
    return send_from_directory(static_dir, 'sw.js', mimetype='application/javascript')


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True, use_reloader=False)
