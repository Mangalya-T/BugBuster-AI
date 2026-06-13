import express from "express";
import multer from "multer";
import JSZip from "jszip";
import { createServer as createViteServer } from "vite";
import * as ts from "typescript";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});
const JWT_SECRET = process.env.JWT_SECRET || "bugbuster-secret-key";

// Initialize Database
const db = new Database("bugbuster.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analysis_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    role TEXT,
    filename TEXT,
    total_errors INTEGER,
    total_errors_before INTEGER,
    errors_fixed INTEGER,
    new_errors INTEGER,
    success_rate REAL,
    files_analyzed INTEGER,
    analysis_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    report_data TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Migration: Add report_data if it doesn't exist (in case table was created with old schema)
try {
  const columns = db.prepare("PRAGMA table_info(analysis_logs)").all() as any[];
  const hasReportData = columns.some(col => col.name === 'report_data');
  const hasReportPath = columns.some(col => col.name === 'report_path');

  if (!hasReportData) {
    db.exec("ALTER TABLE analysis_logs ADD COLUMN report_data TEXT");
    console.log("Migration: Added report_data column to analysis_logs");
    
    if (hasReportPath) {
      db.exec("UPDATE analysis_logs SET report_data = report_path");
      console.log("Migration: Copied data from report_path to report_data");
    }
  }

  // New Migrations for regression tracking
  const hasTotalErrorsBefore = columns.some(col => col.name === 'total_errors_before');
  if (!hasTotalErrorsBefore) {
    db.exec("ALTER TABLE analysis_logs ADD COLUMN total_errors_before INTEGER DEFAULT 0");
    db.exec("ALTER TABLE analysis_logs ADD COLUMN errors_fixed INTEGER DEFAULT 0");
    db.exec("ALTER TABLE analysis_logs ADD COLUMN new_errors INTEGER DEFAULT 0");
    db.exec("ALTER TABLE analysis_logs ADD COLUMN success_rate REAL DEFAULT 0");
    db.exec("ALTER TABLE analysis_logs ADD COLUMN files_analyzed INTEGER DEFAULT 0");
    console.log("Migration: Added regression tracking columns to analysis_logs");
  }
} catch (err) {
  console.error("Migration failed:", err);
}

app.use(express.json());

// --- AUTHENTICATION MIDDLEWARE ---
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) return res.sendStatus(403);
    
    // Verify user still exists in database to prevent FOREIGN KEY errors
    const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(decoded.id) as any;
    if (!user) {
      return res.status(401).json({ error: "User no longer exists. Please log in again." });
    }
    
    req.user = user;
    next();
  });
};

// --- AUTH ROUTES ---
app.post("/api/register", async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password || !role) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)");
    stmt.run(username, email, password_hash, role);
    res.json({ message: "User registered successfully" });
  } catch (error: any) {
    if (error.message.includes("UNIQUE constraint failed")) {
      res.status(400).json({ error: "Username or email already exists" });
    } else {
      res.status(500).json({ error: "Registration failed" });
    }
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (user && await bcrypt.compare(password, user.password_hash)) {
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// --- CONFIGURABLE RULES (Legacy - Migrated to rules/*.json) ---

interface ConfigurableRule {
  id: string;
  name: string;
  description: string;
  type: string;
  enabled: boolean;
  severity: "pass" | "fail" | "warning";
  language: string;
  pattern?: string;
  message: string;
  suggestion?: string;
}

const DEFAULT_RULES: ConfigurableRule[] = [];

class RuleManager {
  private rules: ConfigurableRule[] = [...DEFAULT_RULES];

  getRules(language?: string): ConfigurableRule[] {
    if (language) {
      return this.rules.filter(r => r.language === language || r.language === "all");
    }
    return this.rules;
  }

  updateRule(id: string, updates: Partial<ConfigurableRule>) {
    const index = this.rules.findIndex(r => r.id === id);
    if (index !== -1) {
      this.rules[index] = { ...this.rules[index], ...updates };
      return true;
    }
    return false;
  }

  addRule(rule: ConfigurableRule) {
    this.rules.push(rule);
  }

  deleteRule(id: string) {
    this.rules = this.rules.filter(r => r.id !== id);
  }

  resetToDefaults() {
    this.rules = [...DEFAULT_RULES];
  }
}

const ruleManager = new RuleManager();

// --- ANALYSIS MODULES (Plug-in Based) ---

interface AnalysisResult {
  type: string;
  status: "pass" | "fail" | "warning";
  message: string;
  details?: {
    line?: number;
    ruleId?: string;
    suggestion?: string;
    [key: string]: any;
  };
}

/**
 * Static Code Analysis Module (Rule-Based)
 * Detects syntax errors, missing docstrings, and unused functions.
 */
class StaticAnalyzer {
  private loadLanguageRules(language: string, role: string) {
    try {
      let ruleFile = "";
      const lang = language.toLowerCase();
      if (lang === "python") ruleFile = "python_rules.json";
      else if (lang === "java") ruleFile = "java_rules.json";
      else if (lang === "c" || lang === "c++") ruleFile = "c_cpp_rules.json";
      else if (lang === "javascript") ruleFile = "javascript_rules.json";
      
      if (ruleFile) {
        const roleDir = role.toLowerCase() === 'tester' ? 'tester' : 'developer';
        const filePath = path.join(process.cwd(), 'rules', roleDir, ruleFile);
        if (fs.existsSync(filePath)) {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
      }
    } catch (e) {
      console.error(`Error loading rules for ${language} (${role}):`, e);
    }
    return [];
  }

  analyze(fileName: string, content: string, language: string, role: string, globalContext?: { functions: Set<string>, calls: Set<string> }): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const ext = fileName.split('.').pop()?.toLowerCase();
    
    // Auto-detect language if not specified
    let effectiveLanguage = language;
    if (language === "auto") {
      const extMap: { [key: string]: string } = {
        'js': 'javascript', 'ts': 'typescript', 'tsx': 'typescript', 'jsx': 'javascript',
        'py': 'python', 'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp',
        'cs': 'csharp', 'go': 'go', 'rs': 'rust', 'php': 'php', 'rb': 'ruby'
      };
      effectiveLanguage = extMap[ext || ''] || 'javascript';
    }
    
    // 1. Load language-specific rules based on role
    const languageRules = this.loadLanguageRules(effectiveLanguage, role);
    
    // 2. Get custom rules from ruleManager
    const customRules = ruleManager.getRules(effectiveLanguage);
    
    const allRules = [...languageRules, ...customRules];

    // 3. Syntax Check (Basic/Language Specific - Built-in Logic)
    if (ext === 'ts' || ext === 'js' || ext === 'tsx' || ext === 'jsx') {
      const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
      const diagnostics = (sourceFile as any).parseDiagnostics;
      if (diagnostics && diagnostics.length > 0) {
        diagnostics.forEach((d: any) => {
          if (d.category === ts.DiagnosticCategory.Error) {
            results.push({
              type: "syntax",
              status: "fail",
              message: `Syntax Error: ${typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText}`,
              details: { line: d.start }
            });
          }
        });
      }
    }

    // 4. Apply All Rules (JSON + Custom)
    allRules.forEach((rule: any) => {
      if (!rule.pattern) return;

      try {
        const regex = new RegExp(rule.pattern, 'gm');
        let match;
        let lastMatchIndex = -1;
        while ((match = regex.exec(content)) !== null) {
          // Prevent infinite loop if regex matches empty string
          if (match.index === lastMatchIndex) {
            regex.lastIndex++;
            continue;
          }
          lastMatchIndex = match.index;

          const line = content.substring(0, match.index).split('\n').length;
          results.push({
            type: rule.type || "syntax",
            status: rule.severity || "warning",
            message: rule.message || rule.name,
            details: { 
              line, 
              ruleId: rule.id,
              suggestion: rule.suggestion
            }
          });
        }
      } catch (e) {
        console.error(`Invalid regex for rule ${rule.id}: ${rule.pattern}`);
      }
    });

    // 4. Code Complexity Check (Generic)
    const complexity = (content.match(/\b(if|for|while|case|catch)\b/g) || []).length;
    if (complexity > 15) {
      results.push({
        type: "syntax",
        status: "warning",
        message: `High Cyclomatic Complexity (${complexity}).`,
        details: { 
          complexity,
          suggestion: "Consider refactoring large functions into smaller, more manageable ones."
        }
      });
    }

    // 5. Language-Specific Logic Rules (Only for the selected language)
    const lines = content.split('\n');

    // --- General Pattern Matching (Inspired by User Request) ---
    lines.forEach((line, index) => {
      const lineStripped = line.trim();
      if (!lineStripped) return;

      // 1. Hardcoded Credentials
      const sensitive = ['password', 'secret', 'api_key', 'token', 'passwd', 'apikey'];
      if (sensitive.some(s => line.toLowerCase().includes(s)) && (line.includes('=') || line.includes(':'))) {
        // Avoid false positives in comments
        if (!lineStripped.startsWith('//') && !lineStripped.startsWith('#') && !lineStripped.startsWith('/*')) {
          // Refine: only flag if it looks like a hardcoded string literal
          const hasLiteral = /["'][^"']{3,}["']/.test(line);
          const isAssignment = /=\s*["']/.test(line) || /:\s*["']/.test(line);
          
          if (hasLiteral && isAssignment) {
            results.push({
              type: "security",
              status: "fail",
              message: "Potential Hardcoded Credential detected.",
              details: { line: index + 1, suggestion: "Move sensitive values to environment variables or a secure configuration file." }
            });
          }
        }
      }

      // 2. Infinite Loop Detection
      if (line.toLowerCase().includes('while(true)') || line.toLowerCase().includes('while (true)') || line.toLowerCase().includes('for (;;)') || line.toLowerCase().includes('while(1)') || line.toLowerCase().includes('while (1)')) {
        results.push({
          type: "syntax",
          status: "warning",
          message: "Potential Infinite Loop detected.",
          details: { line: index + 1, suggestion: "Ensure the loop has a clear exit condition (break or return)." }
        });
      }

      // 3. Debug Statements
      const debugPatterns = [
        { lang: ['javascript', 'typescript'], pattern: /console\.log\(/ },
        { lang: ['python'], pattern: /print\(/ },
        { lang: ['java'], pattern: /System\.out\.println\(/ },
        { lang: ['c', 'cpp'], pattern: /printf\(/ }
      ];
      debugPatterns.forEach(dp => {
        if (dp.lang.includes(effectiveLanguage.toLowerCase()) && dp.pattern.test(line)) {
          results.push({
            type: "syntax",
            status: "warning",
            message: "Debug statement found in production code.",
            details: { line: index + 1, suggestion: "Remove debug statements (like print or console.log) before deploying to production." }
          });
        }
      });

      // 4. Missing Error Handling (Risky Operations)
      const riskyOps = ['open(', 'connect(', 'read(', 'write(', 'fetch(', 'axios.', 'request('];
      if (riskyOps.some(op => line.includes(op))) {
        // Check if within a try block (improved check)
        let inTry = false;
        // Look back up to 20 lines for a try block
        for (let i = Math.max(0, index - 20); i <= index; i++) {
          if (lines[i] && (lines[i].includes('try {') || lines[i].includes('try:') || lines[i].includes('try('))) {
            inTry = true;
            break;
          }
        }
        if (!inTry) {
          results.push({
            type: "syntax",
            status: "warning",
            message: "Risky operation without immediate error handling.",
            details: { line: index + 1, suggestion: "Wrap potentially failing operations (I/O, Network) in try-catch blocks." }
          });
        }
      }

      // 5. Missing Documentation (Functions)
      const funcDef = {
        python: /^def\s+\w+\s*\(.*\):/,
        javascript: /^(?:function\s+\w+|const\s+\w+\s*=\s*\(.*\)\s*=>)/,
        java: /^(?:public|private|protected|static|\s) +[\w\<\>\[\]]+\s+(\w+) *\(/,
        c: /^[\w\*]+\s+(\w+)\s*\(.*\)\s*\{/
      };
      const currentFuncRegex = funcDef[effectiveLanguage.toLowerCase() as keyof typeof funcDef];
      if (currentFuncRegex && currentFuncRegex.test(lineStripped)) {
        // Check up to 3 lines above for comments
        let hasDoc = false;
        for (let i = 1; i <= 3; i++) {
          const prevLine = lines[index - i]?.trim() || '';
          if (prevLine.startsWith('/**') || prevLine.startsWith('"""') || prevLine.startsWith("'''") || prevLine.startsWith('//') || prevLine.startsWith('#') || prevLine.startsWith('*')) {
            hasDoc = true;
            break;
          }
        }
        if (!hasDoc) {
          results.push({
            type: "syntax",
            status: "warning",
            message: "Function missing documentation/comments.",
            details: { line: index + 1, suggestion: "Add a docstring or comment explaining the function's purpose and parameters." }
          });
        }
      }
    });

    // Java/JS Specific Semicolon Logic
    if (['java', 'javascript', 'typescript'].includes(effectiveLanguage.toLowerCase()) || ['java', 'js', 'ts', 'tsx', 'jsx'].includes(ext || '')) {
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '' || 
            trimmed.startsWith('//') || 
            trimmed.startsWith('/*') || 
            trimmed.startsWith('*') || 
            trimmed.startsWith('import') || 
            trimmed.startsWith('package') || 
            trimmed.endsWith('{') || 
            trimmed.endsWith('}') || 
            trimmed.endsWith(';') || 
            trimmed.endsWith(':') ||
            trimmed.endsWith(',') || // Multi-line array/object
            trimmed.endsWith('.') || // Chained call
            trimmed.endsWith('+') || // String concatenation
            trimmed.endsWith('-') ||
            trimmed.endsWith('*') ||
            trimmed.endsWith('/') ||
            trimmed.endsWith('?') || // Ternary
            trimmed.includes('/*')) return;
        
        // Basic check for statements that usually need semicolons
        const needsSemicolon = /^(?:public|private|protected|static|final|const|let|var|return|throw)\b|^\w+\s*\(.*\)|\w+\s*=[^=]/;
        
        if (needsSemicolon.test(trimmed)) {
           // Ensure it's not a function definition header or a class header
           if (trimmed.includes('class ') || trimmed.includes('interface ')) return;

           if (trimmed.includes('(') && !trimmed.includes(';')) {
              const hasClosingParen = trimmed.endsWith(')');
              if (hasClosingParen) {
                results.push({
                  type: "syntax",
                  status: "warning",
                  message: "Syntax Warning: Missing semicolon (;) at the end of the statement.",
                  details: { line: index + 1, suggestion: "Add a semicolon ';' at the end of the line for better code clarity." }
                });
              }
           } else if (!trimmed.includes('(')) {
              results.push({
                type: "syntax",
                status: "warning",
                message: "Syntax Warning: Missing semicolon (;) at the end of the statement.",
                details: { line: index + 1, suggestion: "Add a semicolon ';' at the end of the line for better code clarity." }
              });
           }
        }
      });
    }

    // Python Specific Logic
    if (effectiveLanguage.toLowerCase() === 'python' || ext === 'py') {
      // Compatibility Check (Python 2 vs 3)
      lines.forEach((line, index) => {
        if (line.includes('xrange(')) {
          results.push({
            type: "compatibility",
            status: "fail",
            message: "Python 2 'xrange' detected.",
            details: { line: index + 1, suggestion: "Use 'range' for Python 3 compatibility." }
          });
        }
        if (line.trim().startsWith('print ') && !line.trim().includes('(')) {
          results.push({
            type: "compatibility",
            status: "fail",
            message: "Python 2 style print statement detected.",
            details: { line: index + 1, suggestion: "Use print() function for Python 3 compatibility." }
          });
        }
      });

      // Missing Colon Check
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return;
        
        // Remove comments for analysis
        const codePart = trimmed.split('#')[0].trim();
        if (codePart === '') return;

        const colonKeywords = /^(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
        if (colonKeywords.test(codePart) && !codePart.endsWith(':')) {
           results.push({
             type: "syntax",
             status: "fail",
             message: `Syntax Error: Missing colon (:) at the end of '${codePart.split(/\s+/)[0]}' statement.`,
             details: { line: index + 1, suggestion: "Add a colon ':' at the end of the statement." }
           });
        }
      });

      // Unused Imports
      const importLines = content.matchAll(/^(?:import\s+([\w, ]+)|from\s+[\w.]+\s+import\s+([\w, ]+))/gm);
      const importedNames: string[] = [];

      for (const match of importLines) {
        const namesStr = match[1] || match[2];
        if (namesStr) {
          const names = namesStr.split(',').map(n => n.trim());
          names.forEach(n => {
            const parts = n.split(/\s+as\s+/);
            const nameToTrack = parts.length > 1 ? parts[1] : parts[0];
            if (nameToTrack && nameToTrack !== '*') importedNames.push(nameToTrack);
          });
        }
      }

      const contentForUsage = content
        .replace(/#.*$/gm, '')
        .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '')
        .replace(/'[^']*'|"[^"]*"/g, '')
        .replace(/^(?:import\s+[\w, ]+|from\s+[\w.]+\s+import\s+[\w, ]+)/gm, '');

      const uniqueImports = Array.from(new Set(importedNames));
      uniqueImports.forEach(name => {
        const usageRegex = new RegExp(`\\b${name}\\b`, 'g');
        if (!usageRegex.test(contentForUsage)) {
          results.push({ 
            type: "unused_import", 
            status: "warning", 
            message: `Potentially unused import: ${name}`,
            details: { 
              ruleId: "python-unused-imports",
              suggestion: `Remove the unused import '${name}' to clean up the code.`
            }
          });
        }
      });
    }

    // C/C++ Specific Logic
    if (['c', 'cpp', 'h', 'hpp'].includes(effectiveLanguage.toLowerCase()) || ['c', 'cpp', 'h', 'hpp'].includes(ext || '')) {
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Skip empty, comments, preprocessor, and block markers
        if (trimmed === '' || 
            trimmed.startsWith('//') || 
            trimmed.startsWith('/*') || 
            trimmed.startsWith('*') || 
            trimmed.startsWith('#') || 
            trimmed.endsWith('{') || 
            trimmed.endsWith('}') || 
            trimmed.endsWith(';') || 
            trimmed.endsWith(':') || // Labels/cases
            trimmed.includes('/*')) return;
        
        // Basic check for statements that usually need semicolons
        // 1. Variable declarations: int x = 5
        // 2. Function calls: printf("hi")
        // 3. Assignments: x = y + z
        // 4. Return statements: return 0
        const needsSemicolon = /^(?:int|char|float|double|void|struct|enum|long|short|unsigned|signed|auto|bool|return)\b|^\w+\s*\(.*\)|\w+\s*=[^=]/;
        const controlFlow = /^(?:if|while|for|switch|else|do)\b/;
        
        if (needsSemicolon.test(trimmed) && !controlFlow.test(trimmed)) {
           // Check next line for opening brace to avoid false positives on function definitions
           const nextLine = lines[index + 1]?.trim() || '';
           if (nextLine.startsWith('{')) return;

           // Ensure it's not a function definition header
           if (trimmed.includes('(') && !trimmed.includes(';')) {
              // If it has a closing paren but no semicolon and no opening brace on same line
              const hasClosingParen = trimmed.includes(')');
              if (hasClosingParen && !trimmed.includes('{')) {
                results.push({
                  type: "syntax",
                  status: "fail",
                  message: "Syntax Error: Missing semicolon (;) at the end of the statement.",
                  details: { line: index + 1, suggestion: "Add a semicolon ';' at the end of the line." }
                });
              }
           } else if (!trimmed.includes('(') && !trimmed.includes('{')) {
              // Simple assignment or declaration
              results.push({
                type: "syntax",
                status: "fail",
                message: "Syntax Error: Missing semicolon (;) at the end of the statement.",
                details: { line: index + 1, suggestion: "Add a semicolon ';' at the end of the line." }
              });
           }
        }
      });
    }

    // Java Specific Logic
    if (language.toLowerCase() === 'java' || ext === 'java') {
      const ioOperations = [
        'FileInputStream', 'FileOutputStream', 'FileReader', 'FileWriter',
        'Socket', 'ServerSocket', 'DriverManager.getConnection', 'Scanner(new File'
      ];
      
      const hasIO = ioOperations.some(op => content.includes(op));
      const hasTryCatch = content.includes('try {') || content.includes('try(');
      const hasThrows = /\bthrows\s+\w+/.test(content);

      if (hasIO && !hasTryCatch && !hasThrows) {
        results.push({
          type: "syntax",
          status: "warning",
          message: "Potential missing error handling for I/O operations.",
          details: {
            ruleId: "java-missing-try-catch",
            suggestion: "Wrap I/O operations in a try-catch block or add a 'throws' clause to the method signature."
          }
        });
      }
    }

    // Unused Function Check (Generic but language-aware regex)
    const nameRegex: any = {
      python: /def\s+(\w+)\s*\(/g,
      javascript: /function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*\(.*\)\s*=>/g,
      java: /(?:public|private|protected|static|\s) +[\w\<\>\[\]]+\s+(\w+) *\(/g,
      c: /[\w\*]+\s+(\w+)\s*\(.*\)\s*\{/g
    };
    const langKey = effectiveLanguage.toLowerCase();
    const nRegex = nameRegex[langKey];
    
    if (nRegex) {
      const definedFunctions: string[] = [];
      let match;
      nRegex.lastIndex = 0;
      while ((match = nRegex.exec(content)) !== null) {
        const name = match[1] || match[2];
        if (name && name !== 'main') definedFunctions.push(name);
      }

      const unused = definedFunctions.filter(name => {
        // If we have global context, check if the function is called anywhere in the project
        if (globalContext) {
          return !globalContext.calls.has(name);
        }
        
        const callRegex = new RegExp(`\\b${name}\\s*\\(`, 'g');
        const matches = content.match(callRegex);
        return !matches || matches.length <= 1;
      });

      if (unused.length > 0) {
        results.push({
          type: "unused_function",
          status: "warning",
          message: `Detected ${unused.length} potentially unused functions.`,
          details: { 
            unused,
            suggestion: `Remove or use the following functions: ${unused.join(', ')}`
          }
        });
      }
    }

    // Unused Variable Check (Basic)
    const varRegex: any = {
      python: /^(\w+)\s*=[^=]/gm,
      javascript: /\b(?:const|let|var)\s+(\w+)\s*=/g,
      java: /\b(?:int|String|double|boolean|float|long|char|byte|short|[\w\<\>\[\]]+)\s+(\w+)\s*=/g,
      c: /\b(?:int|float|double|char|long|short|[\w\*]+)\s+(\w+)\s*=/g
    };
    const vRegex = varRegex[langKey];
    if (vRegex) {
      vRegex.lastIndex = 0;
      let match;
      while ((match = vRegex.exec(content)) !== null) {
        const name = match[1];
        if (name && !['return', 'if', 'for', 'while', 'import', 'from', 'class', 'def', 'public', 'private', 'static', 'final'].includes(name)) {
          const usageRegex = new RegExp(`\\b${name}\\b`, 'g');
          const usages = content.match(usageRegex);
          if (usages && usages.length === 1) {
             results.push({
               type: "syntax",
               status: "warning",
               message: `Unused variable detected: '${name}'.`,
               details: { 
                 line: content.substring(0, match.index).split('\n').length,
                 suggestion: `Remove the unused variable '${name}' to clean up the code.` 
               }
             });
          }
        }
      }
    }

    if (!results.some(r => r.status === "fail" || r.status === "warning")) {
      results.push({ type: "syntax", status: "pass", message: "Static analysis passed with no issues." });
    }

    return results;
  }

  getAST(fileName: string, content: string, language: string): any {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const nodes: any[] = [];
    const edges: any[] = [];
    let idCounter = 0;

    const levels: { [key: number]: number } = {};

    const addNode = (label: string, type: string, parentId?: string, level: number = 0) => {
      const id = `node-${idCounter++}`;
      
      if (!levels[level]) levels[level] = 0;
      const x = levels[level] * 200;
      const y = level * 150;
      levels[level]++;

      nodes.push({ 
        id, 
        parentId,
        data: { label, type, parentId }, 
        position: { x, y },
        type: 'default'
      });

      if (parentId) {
        edges.push({ id: `edge-${parentId}-${id}`, source: parentId, target: id, animated: true, style: { stroke: '#94a3b8' } });
      }
      return id;
    };

    const rootId = addNode(fileName, "root", undefined, 0);

    if (ext === 'ts' || ext === 'js' || ext === 'tsx' || ext === 'jsx') {
      const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
      
      const visit = (node: ts.Node, parentId: string, level: number) => {
        let nodeId = parentId;
        let currentLevel = level;

        if (ts.isClassDeclaration(node) && node.name) {
          nodeId = addNode(`Class: ${node.name.text}`, "class", parentId, level + 1);
          currentLevel = level + 1;
        } else if (ts.isFunctionDeclaration(node) && node.name) {
          nodeId = addNode(`Function: ${node.name.text}`, "function", parentId, level + 1);
          currentLevel = level + 1;
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          nodeId = addNode(`Method: ${node.name.text}`, "method", parentId, level + 1);
          currentLevel = level + 1;
        } else if (ts.isVariableStatement(node)) {
           node.declarationList.declarations.forEach(decl => {
             if (ts.isIdentifier(decl.name)) {
                addNode(`Var: ${decl.name.text}`, "variable", parentId, level + 1);
             }
           });
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          nodeId = addNode(`Interface: ${node.name.text}`, "interface", parentId, level + 1);
          currentLevel = level + 1;
        }
        
        ts.forEachChild(node, (child) => visit(child, nodeId, currentLevel));
      };
      
      ts.forEachChild(sourceFile, (node) => visit(node, rootId, 0));
    } else {
      // Improved Regex-based structural analysis for other languages
      const lKey = language.toLowerCase();
      
      const patterns: any = {
        python: [
          { regex: /class\s+(\w+)/g, type: 'class', prefix: 'Class' },
          { regex: /def\s+(\w+)/g, type: 'function', prefix: 'Def' },
          { regex: /(\w+)\s*=\s*/g, type: 'variable', prefix: 'Var' }
        ],
        java: [
          { regex: /class\s+(\w+)/g, type: 'class', prefix: 'Class' },
          { regex: /interface\s+(\w+)/g, type: 'interface', prefix: 'Interface' },
          { regex: /(?:public|private|protected|static|\s) +[\w\<\>\[\]]+\s+(\w+) *\(/g, type: 'method', prefix: 'Method' },
          { regex: /(?:int|String|boolean|double|float|long|char|var)\s+(\w+)\s*[;=]/g, type: 'variable', prefix: 'Var' }
        ],
        c: [
          { regex: /struct\s+(\w+)/g, type: 'class', prefix: 'Struct' },
          { regex: /[\w\*]+\s+(\w+)\s*\(.*\)\s*\{/g, type: 'function', prefix: 'Func' },
          { regex: /(?:int|char|float|double|void)\s+\*?(\w+)\s*[;=]/g, type: 'variable', prefix: 'Var' }
        ]
      };

      const langPatterns = patterns[lKey] || patterns.python;
      
      langPatterns.forEach((p: any) => {
        let match;
        // Reset regex index
        p.regex.lastIndex = 0;
        while ((match = p.regex.exec(content)) !== null) {
          const name = match[1];
          if (name && !['if', 'for', 'while', 'return', 'switch', 'case'].includes(name)) {
            addNode(`${p.prefix}: ${name}`, p.type, rootId, 1);
          }
        }
      });
    }

    return { nodes, edges };
  }
}

// --- API ENDPOINTS ---

app.get("/api/rules", (req, res) => {
  const language = req.query.language as string;
  res.json(ruleManager.getRules(language));
});

app.post("/api/rules", (req, res) => {
  const { id, updates } = req.body;
  if (!id || !updates) return res.status(400).json({ error: "Missing id or updates" });
  const success = ruleManager.updateRule(id, updates);
  if (success) {
    res.json({ message: "Rule updated successfully" });
  } else {
    res.status(404).json({ error: "Rule not found" });
  }
});

app.post("/api/rules/add", (req, res) => {
  const rule = req.body;
  if (!rule.id || !rule.name) return res.status(400).json({ error: "Invalid rule data" });
  ruleManager.addRule(rule);
  res.json({ message: "Rule added successfully" });
});

app.delete("/api/rules/:id", (req, res) => {
  const { id } = req.params;
  ruleManager.deleteRule(id);
  res.json({ message: "Rule deleted successfully" });
});

app.post("/api/rules/reset", (req, res) => {
  ruleManager.resetToDefaults();
  res.json({ message: "Rules reset to defaults" });
});

app.post("/api/analyze", authenticateToken, upload.single("file"), async (req, res) => {
  console.log(`Received analysis request for file: ${req.file?.originalname}, size: ${req.file?.size} bytes`);
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const selectedLanguage = req.body.language || "auto";
  const user = (req as any).user;

  let zip;
  try {
    zip = await JSZip.loadAsync(req.file.buffer);
  } catch (zipError) {
    console.error("ZIP Parsing Error:", zipError);
    return res.status(400).json({ error: "Invalid ZIP file. Please ensure you are uploading a valid .zip archive." });
  }

  try {
    const staticAnalyzer = new StaticAnalyzer();

    const fullReport: any[] = [];
    let overallStatus: "pass" | "fail" = "pass";
    let totalErrors = 0;

    const fileEntries = Object.entries(zip.files).filter(([fileName, file]: [string, any]) => {
      return !file.dir && fileName.match(/\.(js|ts|py|java|c|cpp|h|cs|go|rs|php|rb|html|css)$/);
    });

    // Process files for static analysis
    const filesToAnalyze = fileEntries.slice(0, 20); 
    
    // Pass 1: Global Context Extraction (for cross-file analysis like unused functions)
    const globalContext = {
      functions: new Set<string>(),
      calls: new Set<string>()
    };

    for (const [fileName, file] of filesToAnalyze as any[]) {
      try {
        const content = await (file as any).async("string");
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const extMap: { [key: string]: string } = {
          'js': 'javascript', 'ts': 'typescript', 'tsx': 'typescript', 'jsx': 'javascript',
          'py': 'python', 'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp',
          'cs': 'csharp', 'go': 'go', 'rs': 'rust', 'php': 'php', 'rb': 'ruby'
        };
        const lang = selectedLanguage === "auto" ? (extMap[ext] || 'javascript') : selectedLanguage.toLowerCase();
        
        // Extract function definitions
        const defRegexes: any = {
          python: /def\s+(\w+)\s*\(/g,
          javascript: /function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*\(.*\)\s*=>/g,
          java: /(?:public|private|protected|static|\s) +[\w\<\>\[\]]+\s+(\w+) *\(/g,
          c: /[\w\*]+\s+(\w+)\s*\(.*\)\s*\{/g
        };
        const dRegex = defRegexes[lang];
        if (dRegex) {
          let m;
          while ((m = dRegex.exec(content)) !== null) {
            const name = m[1] || m[2];
            if (name) globalContext.functions.add(name);
          }
        }

        // Extract potential calls (very broad)
        const callMatches = content.match(/\b\w+\s*\(/g);
        if (callMatches) {
          callMatches.forEach(c => {
            const name = c.split('(')[0].trim();
            if (name) globalContext.calls.add(name);
          });
        }
      } catch (e) {}
    }

    const analysisPromises = filesToAnalyze.map(async ([fileName, file]: [string, any]) => {
      try {
        const content = await file.async("string");
        // Truncate content for display more aggressively to prevent payload issues (50KB)
        const displayContent = content.length > 50000 ? content.substring(0, 50000) + "\n... [File truncated for display performance] ..." : content;
        
        // Run static analysis with global context
        const staticResults = staticAnalyzer.analyze(fileName, content, selectedLanguage, user.role, globalContext);
        const ast = staticAnalyzer.getAST(fileName, content, selectedLanguage);

        return {
          fileName,
          content: displayContent,
          results: staticResults,
          ast
        };
      } catch (fileError: any) {
        console.error(`Error analyzing file ${fileName}:`, fileError);
        return {
          fileName,
          content: "[Error reading file content]",
          results: [{ 
            type: "system", 
            status: "warning", 
            message: `Failed to analyze this file: ${fileError.message}`,
            details: { suggestion: "Ensure the file is text-based and not corrupted." }
          }],
          ast: { nodes: [], edges: [] }
        };
      }
    });

    const results = await Promise.all(analysisPromises);

    if (results.length === 0) {
      return res.status(400).json({ error: "No source files found in the ZIP archive. Supported extensions: .js, .ts, .py, .java, .c, .cpp, .h, .cs, .go, .rs, .php, .rb, .html, .css" });
    }

    let totalWarnings = 0;

    for (const fileReport of results) {
      const errorsInFile = fileReport.results.filter(r => r.status === "fail").length;
      const warningsInFile = fileReport.results.filter(r => r.status === "warning").length;
      totalErrors += errorsInFile;
      totalWarnings += warningsInFile;

      if (errorsInFile > 0) {
        overallStatus = "fail";
      }

      fullReport.push(fileReport);
    }

    // Calculate Code Quality Score (0-100)
    // Deduct 10 points for each error, 2 points for each warning
    const qualityScore = Math.max(0, 100 - (totalErrors * 10) - (totalWarnings * 2));

    // Regression Testing Logic
    const lastLog: any = db.prepare("SELECT total_errors, report_data FROM analysis_logs WHERE user_id = ? AND filename = ? ORDER BY analysis_time DESC LIMIT 1").get(user.id, req.file.originalname);
    
    let totalErrorsBefore = 0;
    let errorsFixed = 0;
    let newErrors = 0;
    let successRate = 0;

    if (lastLog) {
      totalErrorsBefore = lastLog.total_errors || 0;
      
      // More detailed comparison if we have the full report
      if (lastLog.report_data) {
        try {
          const prevReport = JSON.parse(lastLog.report_data);
          if (prevReport && prevReport.files) {
            // Compare issues by file and message/line to find truly fixed vs new
            const prevIssues = new Set();
            prevReport.files.forEach((f: any) => {
              f.results.forEach((r: any) => {
                if (r.status === "fail") {
                  prevIssues.add(`${f.fileName}:${r.message}:${r.details?.line || 0}`);
                }
              });
            });

            const currentIssues = new Set();
            fullReport.forEach((f: any) => {
              f.results.forEach((r: any) => {
                if (r.status === "fail") {
                  currentIssues.add(`${f.fileName}:${r.message}:${r.details?.line || 0}`);
                }
              });
            });

            // Fixed: In prev but not in current
            prevIssues.forEach((issue: any) => {
              if (!currentIssues.has(issue)) errorsFixed++;
            });

            // New: In current but not in prev
            currentIssues.forEach((issue: any) => {
              if (!prevIssues.has(issue)) newErrors++;
            });
          } else {
            // Fallback to simple count diff
            errorsFixed = Math.max(0, totalErrorsBefore - totalErrors);
            newErrors = Math.max(0, totalErrors - totalErrorsBefore);
          }
        } catch (e) {
          errorsFixed = Math.max(0, totalErrorsBefore - totalErrors);
          newErrors = Math.max(0, totalErrors - totalErrorsBefore);
        }
      } else {
        errorsFixed = Math.max(0, totalErrorsBefore - totalErrors);
        newErrors = Math.max(0, totalErrors - totalErrorsBefore);
      }
    }

    // Success Rate Formula: ((total_errors_before - remaining_errors_after) / total_errors_before) * 100
    // If totalErrorsBefore is 0, and we have 0 errors now, it's 100%. If we have errors now, it's 0%.
    if (totalErrorsBefore > 0) {
      successRate = Math.max(0, ((totalErrorsBefore - totalErrors) / totalErrorsBefore) * 100);
    } else {
      successRate = totalErrors === 0 ? 100 : 0;
    }

    const regressionInfo = {
      previousErrors: totalErrorsBefore,
      fixedErrors: errorsFixed,
      newErrors: newErrors,
      successRate: Math.round(successRate * 10) / 10
    };

    const reportPayload = {
      verdict: overallStatus === "pass" ? "Code is production-ready" : "Code failed validation",
      timestamp: new Date().toISOString(),
      language: selectedLanguage,
      files: fullReport,
      totalErrors,
      totalWarnings,
      qualityScore,
      regressionInfo,
      filesAnalyzed: fullReport.length
    };

    // Log analysis (truncate report data for DB if it's too large)
    try {
      const dbReportPayload = { ...reportPayload };
      // Don't store full file contents in DB logs to save space and prevent errors
      dbReportPayload.files = dbReportPayload.files.map(f => ({ ...f, content: "[Content omitted in logs]" }));
      
      const stmt = db.prepare("INSERT INTO analysis_logs (user_id, role, filename, total_errors, total_errors_before, errors_fixed, new_errors, success_rate, files_analyzed, report_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      stmt.run(user.id, user.role, req.file.originalname, totalErrors, totalErrorsBefore, errorsFixed, newErrors, successRate, fullReport.length, JSON.stringify(dbReportPayload));
    } catch (dbError) {
      console.error("Failed to log analysis to database:", dbError);
      // Continue anyway to return the report to the user
    }

    console.log(`Analysis complete for ${req.file.originalname}. Errors: ${totalErrors}, Warnings: ${totalWarnings}`);
    res.json(reportPayload);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Analysis failed during processing." });
  }
});

app.post("/api/reanalyze", authenticateToken, async (req, res) => {
  const { files, language } = req.body;
  const user = (req as any).user;

  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ error: "Files array is required" });
  }

  try {
    const selectedLanguage = language || "auto";
    const staticAnalyzer = new StaticAnalyzer();
    
    // Global context for unused function detection
    const globalContext = {
      functions: new Set<string>(),
      calls: new Set<string>()
    };

    // First pass for global context
    for (const file of files) {
      const content = file.content;
      const lang = selectedLanguage === "auto" ? (file.fileName.split('.').pop()?.toLowerCase() || 'javascript') : selectedLanguage;
      
      const defRegexes: any = {
        javascript: /function\s+(\w+)|const\s+(\w+)\s*=\s*\(.*\)\s*=>/g,
        typescript: /function\s+(\w+)|const\s+(\w+)\s*=\s*\(.*\)\s*=>/g,
        python: /def\s+(\w+)\s*\(/g,
        java: /(?:public|private|protected|static|\s) +[\w\<\>\[\]]+\s+(\w+) *\(/g,
        c: /[\w\*]+\s+(\w+)\s*\(.*\)\s*\{/g
      };
      const dRegex = defRegexes[lang];
      if (dRegex) {
        let m;
        while ((m = dRegex.exec(content)) !== null) {
          const name = m[1] || m[2];
          if (name) globalContext.functions.add(name);
        }
      }

      const callMatches = content.match(/\b\w+\s*\(/g);
      if (callMatches) {
        callMatches.forEach((c: string) => {
          const name = c.split('(')[0].trim();
          if (name) globalContext.calls.add(name);
        });
      }
    }

    let totalErrors = 0;
    let totalWarnings = 0;
    const fullReport = [];

    for (const file of files) {
      const staticResults = staticAnalyzer.analyze(file.fileName, file.content, selectedLanguage, user.role, globalContext);
      const ast = staticAnalyzer.getAST(file.fileName, file.content, selectedLanguage);
      
      const errorsInFile = staticResults.filter(r => r.status === "fail").length;
      const warningsInFile = staticResults.filter(r => r.status === "warning").length;
      
      totalErrors += errorsInFile;
      totalWarnings += warningsInFile;

      fullReport.push({
        fileName: file.fileName,
        content: file.content,
        results: staticResults,
        ast
      });
    }

    const qualityScore = Math.max(0, 100 - (totalErrors * 10) - (totalWarnings * 2));

    // Regression Testing Logic for Re-analysis
    const lastLog: any = db.prepare("SELECT total_errors, report_data FROM analysis_logs WHERE user_id = ? AND filename = ? ORDER BY analysis_time DESC LIMIT 1").get(user.id, "Manual Re-analysis");
    
    let totalErrorsBefore = 0;
    let errorsFixed = 0;
    let newErrors = 0;
    let successRate = 0;

    if (lastLog) {
      totalErrorsBefore = lastLog.total_errors || 0;
      if (lastLog.report_data) {
        try {
          const prevReport = JSON.parse(lastLog.report_data);
          if (prevReport && prevReport.files) {
            const prevIssues = new Set();
            prevReport.files.forEach((f: any) => {
              f.results.forEach((r: any) => {
                if (r.status === "fail") prevIssues.add(`${f.fileName}:${r.message}:${r.details?.line || 0}`);
              });
            });

            const currentIssues = new Set();
            fullReport.forEach((f: any) => {
              f.results.forEach((r: any) => {
                if (r.status === "fail") currentIssues.add(`${f.fileName}:${r.message}:${r.details?.line || 0}`);
              });
            });

            prevIssues.forEach((issue: any) => {
              if (!currentIssues.has(issue)) errorsFixed++;
            });

            currentIssues.forEach((issue: any) => {
              if (!prevIssues.has(issue)) newErrors++;
            });
          }
        } catch (e) {}
      }
    }

    if (totalErrorsBefore > 0) {
      successRate = Math.max(0, ((totalErrorsBefore - totalErrors) / totalErrorsBefore) * 100);
    } else {
      successRate = totalErrors === 0 ? 100 : 0;
    }

    const finalResponse = {
      language: selectedLanguage,
      totalErrors,
      totalWarnings,
      qualityScore,
      files: fullReport,
      timestamp: new Date().toISOString(),
      regressionInfo: {
        previousErrors: totalErrorsBefore,
        fixedErrors: errorsFixed,
        newErrors: newErrors,
        successRate: Math.round(successRate * 10) / 10
      },
      filesAnalyzed: fullReport.length
    };

    // Log the re-analysis
    const dbReportPayload = { ...finalResponse };
    dbReportPayload.files = dbReportPayload.files.map(f => ({ ...f, content: "[Content omitted in logs]" }));

    db.prepare("INSERT INTO analysis_logs (user_id, role, filename, total_errors, total_errors_before, errors_fixed, new_errors, success_rate, files_analyzed, report_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(user.id, user.role, "Manual Re-analysis", totalErrors, totalErrorsBefore, errorsFixed, newErrors, successRate, fullReport.length, JSON.stringify(dbReportPayload));

    res.json(finalResponse);
  } catch (error: any) {
    console.error("Re-analysis error:", error);
    res.status(500).json({ error: "Internal server error during re-analysis: " + error.message });
  }
});

app.get("/api/logs", authenticateToken, (req, res) => {
  const user = (req as any).user;
  let logs;
  if (user.role === 'Admin') {
    logs = db.prepare("SELECT l.*, u.username FROM analysis_logs l JOIN users u ON l.user_id = u.id ORDER BY analysis_time DESC").all();
  } else {
    logs = db.prepare("SELECT l.*, u.username FROM analysis_logs l JOIN users u ON l.user_id = u.id WHERE l.user_id = ? ORDER BY analysis_time DESC").all(user.id);
  }
  res.json(logs);
});

// --- VITE MIDDLEWARE ---

// Global Error Handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Global Error:", err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  res.status(err.status || 500).json({ 
    error: err.message || "An unexpected error occurred on the server." 
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
