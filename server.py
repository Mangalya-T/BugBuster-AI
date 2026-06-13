import os
import json
import sqlite3
import zipfile
import re
import time
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
import google.generativeai as genai

app = Flask(__name__)
CORS(app)

# Configuration
UPLOAD_FOLDER = 'uploads'
DB_PATH = 'database.sqlite'
# Prioritize user-selected API key (API_KEY) over platform key (GEMINI_API_KEY)
GEMINI_API_KEY = os.environ.get('API_KEY') or os.environ.get('GEMINI_API_KEY')

if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

# Database Setup
def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    db = get_db()
    db.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS analysis_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        language TEXT,
        report_data TEXT,
        analysis_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS custom_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        language TEXT,
        rule_json TEXT
    )''')
    db.commit()

init_db()

# Static Analyzer Logic
class StaticAnalyzer:
    def __init__(self):
        self.rules_base_path = 'rules'

    def load_rules(self, language, role):
        role_dir = 'developer' if role == 'Developer' else 'tester'
        lang_file = f"{language.lower()}_rules.json"
        if language.lower() == 'c' or language.lower() == 'cpp':
            lang_file = 'c_cpp_rules.json'
        
        path = os.path.join(self.rules_base_path, role_dir, lang_file)
        if os.path.exists(path):
            with open(path, 'r') as f:
                return json.load(f)
        return []

    def analyze(self, filename, content, language, role):
        results = []
        rules = self.load_rules(language, role)
        
        # Add custom rules
        db = get_db()
        custom_rules_rows = db.execute("SELECT rule_json FROM custom_rules WHERE language = ?", (language.lower(),)).fetchall()
        for row in custom_rules_rows:
            rules.extend(json.loads(row['rule_json']))

        for rule in rules:
            pattern = rule.get('pattern')
            if not pattern:
                continue
            
            try:
                matches = re.finditer(pattern, content, re.MULTILINE)
                for match in matches:
                    line_no = content.count('\n', 0, match.start()) + 1
                    results.append({
                        "id": rule.get('id'),
                        "type": rule.get('type'),
                        "status": rule.get('severity'),
                        "message": rule.get('message'),
                        "suggestion": rule.get('suggestion'),
                        "details": {"line": line_no}
                    })
            except Exception as e:
                print(f"Regex error in rule {rule.get('id')}: {e}")

        return results

# Gemini AI Analysis
class IntelligentTester:
    def __init__(self, api_key):
        if api_key:
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel('gemini-1.5-flash')
        else:
            self.model = None

    def _extract_json(self, text):
        json_match = re.search(r'\{.*\}', text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group())
            except:
                return {}
        return {}

    async def analyze_code(self, filename, content, language, role):
        if not self.model: return {}
        prompt = f"Analyze this {language} file '{filename}' for {role}. Return JSON with 'logicalErrors', 'securityVulnerabilities', 'compatibilityIssues'. Code: {content[:5000]}"
        response = self.model.generate_content(prompt)
        return self._extract_json(response.text)

    async def validate_structure(self, files_list, language):
        if not self.model: return {}
        prompt = f"Validate the structure of this {language} project. Files: {', '.join(files_list)}. Return JSON with 'isValid' (bool), 'missingFiles' (list), 'suggestions' (list)."
        response = self.model.generate_content(prompt)
        return self._extract_json(response.text)

    async def generate_tests(self, filename, content, language):
        if not self.model: return {}
        prompt = f"Generate test cases for this {language} file '{filename}'. Return JSON with 'testCases' array containing 'name', 'type', 'input', 'expectedOutput'. Code: {content[:5000]}"
        response = self.model.generate_content(prompt)
        return self._extract_json(response.text)

# Routes
@app.route('/api/validate-structure', methods=['POST'])
async def validate_structure():
    data = request.json
    files = data.get('files', [])
    language = data.get('language', 'javascript')
    tester = IntelligentTester(GEMINI_API_KEY)
    result = await tester.validate_structure(files, language)
    return jsonify(result)

@app.route('/api/generate-tests', methods=['POST'])
async def generate_tests():
    data = request.json
    filename = data.get('filename')
    content = data.get('content')
    language = data.get('language', 'javascript')
    tester = IntelligentTester(GEMINI_API_KEY)
    result = await tester.generate_tests(filename, content, language)
    return jsonify(result)

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    db = get_db()
    try:
        db.execute("INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
                   (data['username'], data['password'], data['role']))
        db.commit()
        return jsonify({"message": "User registered"}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": "Username exists"}), 400

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE username = ? AND password = ?",
                      (data['username'], data['password'])).fetchone()
    if user:
        return jsonify({
            "id": user['id'],
            "username": user['username'],
            "role": user['role']
        })
    return jsonify({"error": "Invalid credentials"}), 401

@app.route('/api/analyze', methods=['POST'])
async def analyze():
    if 'file' not in request.files:
        return jsonify({"error": "No file"}), 400
    
    file = request.files['file']
    user_id = request.form.get('userId')
    role = request.form.get('role')
    language = request.form.get('language', 'javascript')
    
    if not file or not user_id:
        return jsonify({"error": "Missing data"}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    file.save(filepath)

    results = []
    analyzer = StaticAnalyzer()
    tester = IntelligentTester(GEMINI_API_KEY)
    
    if filename.endswith('.zip'):
        with zipfile.ZipFile(filepath, 'r') as zip_ref:
            for zip_info in zip_ref.infolist():
                if zip_info.is_dir(): continue
                with zip_ref.open(zip_info) as f:
                    content = f.read().decode('utf-8', errors='ignore')
                    file_results = analyzer.analyze(zip_info.filename, content, language, role)
                    ai_results = await tester.analyze_code(zip_info.filename, content, language, role)
                    results.append({
                        "filename": zip_info.filename,
                        "results": file_results,
                        "aiAnalysis": ai_results
                    })
    else:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            file_results = analyzer.analyze(filename, content, language, role)
            ai_results = await tester.analyze_code(filename, content, language, role)
            results.append({
                "filename": filename,
                "results": file_results,
                "aiAnalysis": ai_results
            })

    # Calculate Score
    total_errors = sum(len([r for r in f['results'] if r['status'] == 'fail']) for f in results)
    total_warnings = sum(len([r for r in f['results'] if r['status'] == 'warning']) for f in results)
    quality_score = max(0, 100 - (total_errors * 10) - (total_warnings * 2))

    report = {
        "verdict": "Pass" if total_errors == 0 else "Fail",
        "timestamp": datetime.now().isoformat(),
        "language": language,
        "files": results,
        "totalErrors": total_errors,
        "totalWarnings": total_warnings,
        "qualityScore": quality_score
    }

    db = get_db()
    db.execute("INSERT INTO analysis_logs (user_id, filename, language, report_data) VALUES (?, ?, ?, ?)",
               (user_id, filename, language, json.dumps(report)))
    db.commit()

    return jsonify(report)

@app.route('/api/logs/<int:user_id>', methods=['GET'])
def get_logs(user_id):
    db = get_db()
    logs = db.execute("SELECT * FROM analysis_logs WHERE user_id = ? ORDER BY analysis_time DESC", (user_id,)).fetchall()
    return jsonify([dict(log) for log in logs])

@app.route('/api/rules', methods=['GET', 'POST'])
def manage_rules():
    db = get_db()
    if request.method == 'POST':
        data = request.json
        db.execute("INSERT INTO custom_rules (language, rule_json) VALUES (?, ?)",
                   (data['language'], json.dumps(data['rules'])))
        db.commit()
        return jsonify({"message": "Rule added"})
    
    rules = db.execute("SELECT * FROM custom_rules").fetchall()
    return jsonify([dict(rule) for rule in rules])

# Serve Frontend (if needed)
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path != "" and os.path.exists("dist/" + path):
        return send_from_directory('dist', path)
    else:
        return send_from_directory('dist', 'index.html')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3000)
