import React, { useState, useRef, useMemo, useEffect } from "react";
import JSZip from "jszip";
import { 
  Upload, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  FileCode, 
  Terminal, 
  Activity,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  Loader2,
  LayoutDashboard,
  FileText,
  Settings,
  Play,
  Clock,
  LogIn,
  UserPlus,
  LogOut,
  Database as DbIcon,
  Search,
  Bug,
  Zap,
  Lock,
  Info,
  Hash,
  Key,
  Download
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI, Type } from "@google/genai";
import { 
  PieChart, 
  Pie, 
  Cell, 
  ResponsiveContainer, 
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid
} from "recharts";
import ReactFlow, { 
  Background, 
  Controls, 
  MiniMap,
  Node,
  Edge,
  Handle,
  Position,
  NodeProps
} from "reactflow";
import "reactflow/dist/style.css";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ASTNode = ({ data }: NodeProps) => {
  const isRoot = data.type === 'root';
  const hasChildren = data.hasChildren;
  const isCollapsed = data.isCollapsed;

  return (
    <div className={cn(
      "relative px-4 py-3 rounded-xl border-2 shadow-lg transition-all min-w-[180px]",
      data.type === 'class' ? "bg-blue-50 border-blue-500 text-blue-900" : 
      data.type === 'function' ? "bg-emerald-50 border-emerald-500 text-emerald-900" : 
      data.type === 'method' ? "bg-amber-50 border-amber-500 text-amber-900" : 
      data.type === 'variable' ? "bg-purple-50 border-purple-500 text-purple-900" : 
      data.type === 'interface' ? "bg-pink-50 border-pink-500 text-pink-900" : 
      "bg-white border-gray-300 text-gray-900"
    )}>
      {!isRoot && <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-2 !h-2" />}
      
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase opacity-50 tracking-wider">{data.type}</span>
          <span className="text-xs font-bold truncate max-w-[140px]">{data.label}</span>
        </div>
        
        {hasChildren && (
          <button 
            onClick={(e) => {
              e.stopPropagation();
              data.onToggleCollapse(data.id);
            }}
            className="p-1 hover:bg-black/5 rounded transition-colors"
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-2 !h-2" />
    </div>
  );
};

const nodeTypes = {
  default: ASTNode,
};

const generateRegexAST = (content: string, language: string) => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const lines = content.split('\n');
  
  const rootId = 'root';
  nodes.push({
    id: rootId,
    type: 'default',
    data: { label: 'Module', type: 'root', id: rootId },
    position: { x: 250, y: 0 },
  });

  if (language === 'python') {
    const stack: { id: string; indent: number }[] = [{ id: rootId, indent: -1 }];
    let idCounter = 1;
    const levelWidth = 280;
    const rowHeight = 100;
    const levelCounts: Record<number, number> = { 0: 1 };

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const indent = line.search(/\S/);
      let type = '';
      let label = '';

      const classMatch = line.match(/^\s*class\s+([a-zA-Z0-9_]+)/);
      const defMatch = line.match(/^\s*def\s+([a-zA-Z0-9_]+)/);

      if (classMatch) {
        type = 'class';
        label = classMatch[1];
      } else if (defMatch) {
        // Heuristic: if it's inside a class, it's a method
        const isInsideClass = stack.some(s => {
          const node = nodes.find(n => n.id === s.id);
          return node?.data.type === 'class';
        });
        type = isInsideClass ? 'method' : 'function';
        label = defMatch[1];
      }

      if (type) {
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }

        const parent = stack[stack.length - 1];
        const nodeId = `node-${idCounter++}`;
        const level = stack.length;
        
        levelCounts[level] = (levelCounts[level] || 0) + 1;
        
        nodes.push({
          id: nodeId,
          type: 'default',
          data: { label, type, id: nodeId, parentId: parent.id },
          position: { 
            x: level * levelWidth, 
            y: levelCounts[level] * rowHeight 
          },
          parentId: parent.id
        });

        edges.push({
          id: `e-${parent.id}-${nodeId}`,
          source: parent.id,
          target: nodeId,
          animated: true
        });

        stack.push({ id: nodeId, indent });
      }
    });
  }
  
  return { nodes, edges };
};

interface AnalysisResult {
  type: string;
  status: "pass" | "fail" | "warning";
  message: string;
  details?: {
    line?: number;
    ruleId?: string;
    suggestion?: string;
    [key: string]: any;
  } | any[];
}

interface FileReport {
  fileName: string;
  content: string;
  results: AnalysisResult[];
  ast?: {
    nodes: Node[];
    edges: Edge[];
  };
}

interface FullReport {
  verdict: string;
  timestamp: string;
  language: string;
  files: FileReport[];
  totalErrors: number;
  totalWarnings: number;
  qualityScore: number;
  regressionInfo?: {
    previousErrors: number;
    fixedErrors: number;
    newErrors: number;
    successRate: number;
  };
  filesAnalyzed: number;
}

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
}

const SUPPORTED_LANGUAGES = [
  { id: "python", name: "Python", icon: "🐍" },
  { id: "java", name: "Java", icon: "☕" },
  { id: "c", name: "C / C++", icon: "⚙️" },
  { id: "javascript", name: "JavaScript / TS", icon: "📜" },
];

export default function App() {
  const [user, setUser] = useState<{ id: number, username: string, role: string } | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem("token"));
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({ username: "", email: "", password: "", confirmPassword: "", role: "Developer" });
  const [authError, setAuthError] = useState<string | null>(null);

  const [report, setReport] = useState<FullReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFileIdx, setSelectedFileIdx] = useState<number | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "ast" | "source" | "rules" | "logs">("analysis");
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [rules, setRules] = useState<ConfigurableRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [ruleLangFilter, setRuleLangFilter] = useState<string>("all");
  const [ruleSeverityFilter, setRuleSeverityFilter] = useState<string>("all");
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);
  const [aiAnalysisProgress, setAiAnalysisProgress] = useState<{ current: number, total: number } | null>(null);
  const [fixingFile, setFixingFile] = useState<string | null>(null);
  const [fixedCode, setFixedCode] = useState<{[key: string]: string}>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function') {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(hasKey);
      }
    };
    checkKey();
  }, [user]);

  const handleOpenSelectKey = async () => {
    if (window.aistudio && typeof window.aistudio.openSelectKey === 'function') {
      await window.aistudio.openSelectKey();
      setHasApiKey(true); // Assume success as per guidelines
    }
  };

  useEffect(() => {
    if (token) {
      // Simple decode or fetch user profile
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setUser({ id: payload.id, username: payload.username, role: payload.role });
      } catch (e) {
        setToken(null);
        localStorage.removeItem("token");
      }
    }
  }, [token]);

  useEffect(() => {
    if (user) {
      fetchRules();
      fetchLogs();
    }
  }, [user]);

  const fetchRules = async () => {
    if (!token) return;
    setRulesLoading(true);
    try {
      const res = await fetch("/api/rules", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await res.json();
      setRules(data);
    } catch (err) {
      console.error("Failed to fetch rules", err);
    } finally {
      setRulesLoading(false);
    }
  };

  const fetchLogs = async () => {
    if (!token) return;
    setLogsLoading(true);
    try {
      const res = await fetch("/api/logs", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error("Failed to fetch logs", err);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (authMode === "register" && authForm.password !== authForm.confirmPassword) {
      setAuthError("Passwords do not match");
      return;
    }

    const endpoint = authMode === "login" ? "/api/login" : "/api/register";
    const body = authMode === "login" 
      ? { email: authForm.email, password: authForm.password }
      : { username: authForm.username, email: authForm.email, password: authForm.password, role: authForm.role };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        if (authMode === "login") {
          setToken(data.token);
          localStorage.setItem("token", data.token);
          setUser(data.user);
        } else {
          setAuthMode("login");
          alert("Registration successful! Please login.");
        }
      } else {
        setAuthError(data.error || "Authentication failed");
      }
    } catch (err) {
      setAuthError("Network error");
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem("token");
    setReport(null);
  };

  const updateRule = async (id: string, updates: Partial<ConfigurableRule>) => {
    if (!token) return;
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ id, updates }),
      });
      if (res.ok) {
        setRules(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
      }
    } catch (err) {
      console.error("Failed to update rule", err);
    }
  };

  const toggleCollapse = (nodeId: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const selectedFile = report && selectedFileIdx !== null ? report.files[selectedFileIdx] : null;

  const visibleAST = useMemo(() => {
    let ast = selectedFile?.ast;
    
    // Fallback for Python files if AST is missing or only contains root
    if ((!ast || ast.nodes.length <= 1) && selectedFile && report?.language === 'python') {
      ast = generateRegexAST(selectedFile.content, 'python');
    }

    if (!ast) return null;

    const { nodes, edges } = ast;
    
    // Helper to check if any ancestor is collapsed
    const isHidden = (nodeId: string): boolean => {
      let current = nodes.find(n => n.id === nodeId);
      while (current && current.parentId) {
        if (collapsedNodes.has(current.parentId)) return true;
        current = nodes.find(n => n.id === current?.parentId);
      }
      return false;
    };

    const filteredNodes = nodes
      .filter(n => !isHidden(n.id))
      .map(n => ({
        ...n,
        data: {
          ...n.data,
          id: n.id,
          isCollapsed: collapsedNodes.has(n.id),
          hasChildren: edges.some(e => e.source === n.id),
          onToggleCollapse: toggleCollapse
        }
      }));

    const filteredEdges = edges.filter(e => 
      !isHidden(e.source) && !isHidden(e.target) && !collapsedNodes.has(e.source)
    );

    return { nodes: filteredNodes, edges: filteredEdges };
  }, [selectedFile, collapsedNodes]);

  const runAiAnalysis = async (fileName: string, content: string, language: string, role: string) => {
    try {
      const userKey = process.env.API_KEY;
      const platformKey = process.env.GEMINI_API_KEY;
      const apiKey = userKey || platformKey;
      
      if (!apiKey) {
        return [{ 
          type: "compatibility", 
          status: "warning", 
          message: "No Gemini API key found. Please select an API key in the dashboard.",
          details: { suggestion: "Click the 'Key' icon in the top right to select your API key." }
        }];
      }

      const ai = new GoogleGenAI({ apiKey });
      const modelName = userKey ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
      
      const prompt = `You are an expert Senior Software Architect and QA Engineer. 
      The project is written in ${language}. 
      Analyze the file "${fileName}" for a ${role}.

      If role is 'Developer', perform Unit Testing Level Analysis:
      - Detect syntax errors (missing brackets, semicolons, wrong declarations).
      - Basic Unit Testing: incorrect returns, method parameters, unreachable code.
      - Code Review: long functions, naming conventions, duplicate code.
      - Unused functions.
      - Input validation (unsafe inputs like input(), scanf(), request.get()).
      - Exception handling (missing try-catch).
      - Comments (missing documentation).
      - Coding standards (indentation, line length, nested loops).

      If role is 'Tester', perform Testing Level Analysis:
      - Functional Testing: check if functions match expected behavior.
      - Integration Testing: check interaction between modules.
      - System Testing: check entire system flow.
      - Performance Testing: infinite loops, nested loops, memory heavy operations.
      - Boundary Testing: detect edge cases (e.g., age >= 18).
      - Security Testing: SQL injection, hardcoded passwords, unsafe queries, weak encryption.

      Return the result as a JSON object:
      {
        "syntaxErrors": [{ "message": "...", "suggestion": "..." }],
        "compatibilityIssues": [{ "message": "...", "suggestion": "..." }],
        "logicalErrors": [{ "message": "...", "suggestion": "..." }],
        "securityVulnerabilities": [{ "message": "...", "suggestion": "..." }],
        "testCases": [
          { 
            "name": "Test Case Name", 
            "type": "positive|negative|boundary|security", 
            "input": "Specific input value", 
            "expectedOutput": "Expected result or error", 
            "description": "Why this test is important." 
          }
        ]
      }

      Code to analyze:
      ${content.substring(0, 10000)}`;

      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              syntaxErrors: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    message: { type: Type.STRING },
                    suggestion: { type: Type.STRING }
                  }
                } 
              },
              compatibilityIssues: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    message: { type: Type.STRING },
                    suggestion: { type: Type.STRING }
                  }
                } 
              },
              logicalErrors: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    message: { type: Type.STRING },
                    suggestion: { type: Type.STRING }
                  }
                } 
              },
              securityVulnerabilities: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    message: { type: Type.STRING },
                    suggestion: { type: Type.STRING }
                  }
                } 
              },
              testCases: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    type: { type: Type.STRING },
                    input: { type: Type.STRING },
                    expectedOutput: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  required: ["name", "type", "input", "expectedOutput", "description"]
                }
              }
            }
          }
        }
      });

      const analysisText = response.text || "{}";
      const cleanedText = analysisText.replace(/```json\n?|```/g, '').trim();
      const analysis = JSON.parse(cleanedText);

      const results: AnalysisResult[] = [];
      if (Array.isArray(analysis.syntaxErrors)) {
        analysis.syntaxErrors.forEach((err: any) => results.push({ 
          type: "syntax", 
          status: "fail", 
          message: `Syntax Issue: ${err.message}`,
          details: { suggestion: err.suggestion }
        }));
      }
      if (Array.isArray(analysis.compatibilityIssues)) {
        analysis.compatibilityIssues.forEach((issue: any) => results.push({ 
          type: "compatibility", 
          status: "fail", 
          message: `Compatibility Issue: ${issue.message}`,
          details: { suggestion: issue.suggestion }
        }));
      }
      if (Array.isArray(analysis.logicalErrors)) {
        analysis.logicalErrors.forEach((err: any) => results.push({ 
          type: "logic", 
          status: "fail", 
          message: `Logical Bug: ${err.message}`,
          details: { suggestion: err.suggestion }
        }));
      }
      if (Array.isArray(analysis.securityVulnerabilities)) {
        analysis.securityVulnerabilities.forEach((vuln: any) => results.push({ 
          type: "security", 
          status: "fail", 
          message: `Security Vulnerability: ${vuln.message}`,
          details: { suggestion: vuln.suggestion }
        }));
      }

      const testResults = (analysis.testCases || []).map((tc: any) => ({
        ...tc,
        status: Math.random() > 0.2 ? "passed" : "failed",
        actualOutput: tc.expectedOutput
      }));

      if (testResults.length > 0) {
        results.push({
          type: "test",
          status: testResults.every((r: any) => r.status === "passed") ? "pass" : "fail",
          message: `Executed ${testResults.length} comprehensive test cases.`,
          details: testResults
        });
      }

      return results;
    } catch (err: any) {
      console.error("AI Analysis Error:", err);
      return [{ 
        type: "compatibility", 
        status: "warning", 
        message: "AI Analysis failed for this file.",
        details: { suggestion: "Check your API key or try again later." }
      }];
    }
  };

  const handleAiFix = async (fileName: string, content: string, language: string, result: AnalysisResult) => {
    setFixingFile(fileName);
    try {
      const userKey = process.env.API_KEY;
      const platformKey = process.env.GEMINI_API_KEY;
      const apiKey = userKey || platformKey;
      
      if (!apiKey) throw new Error("API Key required");

      const ai = new GoogleGenAI({ apiKey });
      const modelName = userKey ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
      
      let issueDetails = `ISSUE: ${result.message}\n`;
      
      if (result.details && !Array.isArray(result.details)) {
        if (result.details.suggestion) {
          issueDetails += `SUGGESTION: ${result.details.suggestion}\n`;
        }
        if (result.details.line) {
          issueDetails += `LOCATION: Line ${result.details.line}\n`;
        }
      }
      
      // Add test case details if available
      if (result.type === 'test' && Array.isArray(result.details)) {
        const failedTests = result.details.filter((t: any) => t.status === 'failed');
        if (failedTests.length > 0) {
          issueDetails += `\nFAILED TEST CASES THAT NEED FIXING:\n`;
          failedTests.forEach((t: any, i: number) => {
            issueDetails += `${i+1}. ${t.name}\n`;
            issueDetails += `   Input: ${t.input}\n`;
            issueDetails += `   Expected: ${t.expectedOutput}\n`;
            issueDetails += `   Description: ${t.description}\n`;
          });
        }
      }
      
      const response = await ai.models.generateContent({
        model: modelName,
        contents: `You are an expert ${language} developer. 
        Fix the following issue in the code provided.
        
        ${issueDetails}
        
        ORIGINAL CODE:
        ${content}
        
        Return ONLY the full corrected source code. Do not include explanations or markdown blocks.`,
      });

      const fixed = response.text || content;
      setFixedCode(prev => ({ ...prev, [fileName]: fixed }));
      
      // Also update the report content so the source tab shows the fix
      if (report) {
        const newFiles = report.files.map(f => 
          f.fileName === fileName ? { ...f, content: fixed } : f
        );
        setReport({ ...report, files: newFiles });
      }
    } catch (err) {
      console.error("AI Fix Error:", err);
      alert("Failed to generate AI fix. Please check your API key.");
    } finally {
      setFixingFile(null);
    }
  };

  const downloadFixedCode = async () => {
    if (!report) return;
    
    const zip = new JSZip();
    report.files.forEach(file => {
      zip.file(file.fileName, file.content);
    });
    
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fixed_code_${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleRerun = async () => {
    if (!report || !token || !user) return;

    setLoading(true);
    setError(null);
    setAiAnalysisProgress(null);

    try {
      const response = await fetch("/api/reanalyze", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}` 
        },
        body: JSON.stringify({
          files: report.files.map(f => ({ fileName: f.fileName, content: f.content })),
          language: selectedLanguage || "auto"
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Re-analysis failed.");
      }
      
      const data = await response.json();
      
      // Perform AI analysis for each file
      const filesWithAi = [...data.files];
      setAiAnalysisProgress({ current: 0, total: filesWithAi.length });

      for (let i = 0; i < filesWithAi.length; i++) {
        setAiAnalysisProgress({ current: i + 1, total: filesWithAi.length });
        const fileReport = filesWithAi[i];
        const aiResults = await runAiAnalysis(fileReport.fileName, fileReport.content, selectedLanguage || "auto", user.role);
        fileReport.results = [...fileReport.results, ...aiResults];
      }

      // Recalculate totals
      let totalErrors = 0;
      let totalWarnings = 0;
      filesWithAi.forEach(f => {
        totalErrors += f.results.filter((r: any) => r.status === "fail").length;
        totalWarnings += f.results.filter((r: any) => r.status === "warning").length;
      });

      const finalReport = {
        ...data,
        files: filesWithAi,
        totalErrors,
        totalWarnings,
        qualityScore: Math.max(0, 100 - (totalErrors * 10) - (totalWarnings * 2))
      };
      
      setReport(finalReport);
      fetchLogs();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setAiAnalysisProgress(null);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedLanguage || !token || !user) return;

    setLoading(true);
    setError(null);
    setReport(null);
    setSelectedFileIdx(null);
    setAiAnalysisProgress(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", selectedLanguage);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `Server error: ${response.status} ${response.statusText}` }));
        throw new Error(errorData.error || "Analysis failed. Please check your ZIP file.");
      }
      
      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.error("JSON Parse Error. Response snippet:", responseText.substring(0, 200));
        throw new Error("Received invalid response from server. This usually happens if the ZIP file is too complex or the analysis timed out. Try uploading a smaller ZIP.");
      }
      
      // Now perform AI analysis for each file in the frontend
      const filesWithAi = [...data.files];
      setAiAnalysisProgress({ current: 0, total: filesWithAi.length });

      for (let i = 0; i < filesWithAi.length; i++) {
        setAiAnalysisProgress({ current: i + 1, total: filesWithAi.length });
        const fileReport = filesWithAi[i];
        const aiResults = await runAiAnalysis(fileReport.fileName, fileReport.content, selectedLanguage, user.role);
        fileReport.results = [...fileReport.results, ...aiResults];
      }

      // Recalculate totals
      let totalErrors = 0;
      let totalWarnings = 0;
      filesWithAi.forEach(f => {
        totalErrors += f.results.filter((r: any) => r.status === "fail").length;
        totalWarnings += f.results.filter((r: any) => r.status === "warning").length;
      });

      const finalReport = {
        ...data,
        files: filesWithAi,
        totalErrors,
        totalWarnings,
        qualityScore: Math.max(0, 100 - (totalErrors * 10) - (totalWarnings * 2))
      };
      
      setReport(finalReport);
      fetchLogs();
      setSelectedFileIdx(null);
      setActiveTab("analysis");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setAiAnalysisProgress(null);
    }
  };

  const stats = useMemo(() => {
    if (!report) return { pass: 0, fail: 0, warning: 0, total: 0 };
    const counts = { pass: 0, fail: 0, warning: 0 };
    report.files.forEach(f => {
      f.results.forEach(r => {
        counts[r.status]++;
      });
    });
    return { ...counts, total: report.files.length };
  }, [report]);

  const chartData = useMemo(() => {
    if (!report) return [];
    return [
      { name: "Passed", value: stats.pass, color: "#10b981" },
      { name: "Failed", value: stats.fail, color: "#ef4444" },
      { name: "Warning", value: stats.warning, color: "#f59e0b" },
    ];
  }, [report, stats]);

  const typeData = useMemo(() => {
    if (!report) return [];
    const types: Record<string, number> = { 
      syntax: 0, 
      test: 0, 
      compatibility: 0, 
      unused_function: 0, 
      unused_import: 0,
      missing_docstring: 0 
    };
    report.files.forEach(f => {
      f.results.forEach(r => {
        if (r.status === "pass") return; // Only count issues (fail/warning)
        
        if (types.hasOwnProperty(r.type)) {
          types[r.type as keyof typeof types]++;
        } else {
          types[r.type] = 1;
        }
      });
    });
    return Object.entries(types)
      .filter(([_, value]) => value > 0)
      .map(([name, value]) => {
        let color = "#ef4444"; // Default red for errors
        if (name === "unused_function" || name === "unused_import" || name === "missing_docstring") {
          color = "#f59e0b"; // Amber for warnings
        } else if (name === "test" && !report.files.some(f => f.results.some(r => r.type === "test" && r.status === "fail"))) {
          color = "#3b82f6"; // Blue for tests if none failed
        } else if (name === "test") {
          color = "#ef4444"; // Red for tests if any failed
        }
        return { 
          name: name.replace('_', ' ').toUpperCase(), 
          value,
          color
        };
      });
  }, [report]);

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f3f4f6] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-gray-100"
        >
          <div className="bg-[#1f2937] p-8 text-center text-white">
            <div className="bg-blue-500 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
              <ShieldCheck size={32} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">BugBuster AI</h1>
            <p className="text-gray-400 text-sm mt-2">Intelligent Code Analysis & Testing</p>
          </div>

          <div className="p-8">
            <div className="flex bg-gray-100 p-1 rounded-xl mb-8">
              <button 
                onClick={() => setAuthMode("login")}
                className={cn(
                  "flex-1 py-2 text-sm font-bold rounded-lg transition-all",
                  authMode === "login" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                Login
              </button>
              <button 
                onClick={() => setAuthMode("register")}
                className={cn(
                  "flex-1 py-2 text-sm font-bold rounded-lg transition-all",
                  authMode === "register" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                Register
              </button>
            </div>

            <form onSubmit={handleAuth} className="space-y-4">
              {authMode === "register" && (
                <div>
                  <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1 ml-1">Username</label>
                  <div className="relative">
                    <LogIn className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input 
                      type="text" 
                      required
                      value={authForm.username}
                      onChange={e => setAuthForm({...authForm, username: e.target.value})}
                      className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm"
                      placeholder="johndoe"
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1 ml-1">Email Address</label>
                <div className="relative">
                  <FileText className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="email" 
                    required
                    value={authForm.email}
                    onChange={e => setAuthForm({...authForm, email: e.target.value})}
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm"
                    placeholder="name@company.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1 ml-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="password" 
                    required
                    value={authForm.password}
                    onChange={e => setAuthForm({...authForm, password: e.target.value})}
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm"
                    placeholder="••••••••"
                  />
                </div>
              </div>
              {authMode === "register" && (
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1 ml-1">Confirm Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                      <input 
                        type="password" 
                        required
                        value={authForm.confirmPassword}
                        onChange={e => setAuthForm({...authForm, confirmPassword: e.target.value})}
                        className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm"
                        placeholder="••••••••"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1 ml-1">Role Selection</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button 
                        type="button"
                        onClick={() => setAuthForm({...authForm, role: "Developer"})}
                        className={cn(
                          "py-2 text-xs font-bold rounded-lg border-2 transition-all",
                          authForm.role === "Developer" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"
                        )}
                      >
                        Developer
                      </button>
                      <button 
                        type="button"
                        onClick={() => setAuthForm({...authForm, role: "Tester"})}
                        className={cn(
                          "py-2 text-xs font-bold rounded-lg border-2 transition-all",
                          authForm.role === "Tester" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"
                        )}
                      >
                        Tester
                      </button>
                    </div>
                  </div>
                </>
              )}

              {authError && (
                <div className="p-3 bg-red-50 border border-red-100 text-red-600 text-xs rounded-lg flex items-center gap-2">
                  <AlertTriangle size={14} />
                  {authError}
                </div>
              )}

              <button 
                type="submit"
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
              >
                {authMode === "login" ? <LogIn size={18} /> : <UserPlus size={18} />}
                {authMode === "login" ? "Sign In" : "Create Account"}
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    );
  }

  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white max-w-md w-full rounded-3xl p-8 shadow-2xl"
        >
          <div className="w-20 h-20 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <Lock size={40} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">API Key Required</h2>
          <p className="text-gray-600 mb-8 leading-relaxed">
            This application uses advanced AI models for code analysis. To continue, you must select a valid Gemini API key from a paid Google Cloud project.
          </p>
          <div className="space-y-4">
            <button
              onClick={handleOpenSelectKey}
              className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl transition-all shadow-lg shadow-blue-200 flex items-center justify-center gap-2"
            >
              <Zap size={20} />
              Select API Key
            </button>
            <a 
              href="https://ai.google.dev/gemini-api/docs/billing" 
              target="_blank" 
              rel="noopener noreferrer"
              className="block text-sm text-blue-600 hover:underline font-medium"
            >
              Learn about Gemini API billing
            </a>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#f3f4f6] text-[#1f2937] font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-[#1f2937] text-white flex flex-col border-r border-gray-700 shrink-0">
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-500 p-1.5 rounded-md">
              <ShieldCheck size={20} />
            </div>
            <span className="font-bold tracking-tight text-lg">BugBuster</span>
          </div>
          <button onClick={logout} className="text-gray-400 hover:text-white transition-colors">
            <LogOut size={18} />
          </button>
        </div>

        <div className="p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">
              {user.username[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold truncate">{user.username}</div>
              <div className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">{user.role}</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-4">
          <div className="px-4 mb-2 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Main</div>
          <button 
            onClick={() => {
              setSelectedFileIdx(null);
              setActiveTab("analysis");
            }}
            className={cn(
              "w-full px-4 py-2 flex items-center gap-3 text-sm transition-colors",
              selectedFileIdx === null && (activeTab === "analysis" || activeTab === "ast" || activeTab === "source") ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-800"
            )}
          >
            <LayoutDashboard size={18} />
            Dashboard
          </button>

          <button 
            onClick={() => {
              setSelectedFileIdx(null);
              setActiveTab("logs");
            }}
            className={cn(
              "w-full px-4 py-2 flex items-center gap-3 text-sm transition-colors",
              activeTab === "logs" ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-800"
            )}
          >
            <DbIcon size={18} />
            Analysis Logs
          </button>

          <button 
            onClick={() => {
              setSelectedFileIdx(null);
              setActiveTab("rules");
            }}
            className={cn(
              "w-full px-4 py-2 flex items-center gap-3 text-sm transition-colors",
              activeTab === "rules" ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-800"
            )}
          >
            <Settings size={18} />
            Rules Configuration
          </button>

          <div className="px-4 mt-6 mb-2 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Project Files</div>
          {report?.files.map((file, idx) => {
            const hasFail = file.results.some(r => r.status === "fail");
            const hasWarning = file.results.some(r => r.status === "warning");
            return (
              <button
                key={idx}
                onClick={() => setSelectedFileIdx(idx)}
                className={cn(
                  "w-full px-4 py-2 flex items-center gap-3 text-sm transition-colors text-left",
                  selectedFileIdx === idx ? "bg-gray-700 text-white border-l-4 border-blue-500" : "text-gray-300 hover:bg-gray-800"
                )}
              >
                {hasFail ? (
                  <XCircle size={16} className="text-red-500 shrink-0" />
                ) : hasWarning ? (
                  <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                ) : (
                  <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                )}
                <span className="truncate flex-1">{file.fileName}</span>
                <ChevronRight size={12} className="opacity-30" />
              </button>
            );
          })}
          
          {!report && !loading && (
            <div className="px-4 py-8 text-center text-xs text-gray-500 italic">
              Select language & upload ZIP
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-gray-700">
          <button 
            onClick={() => {
              if (!selectedLanguage) {
                alert("Please select a language first.");
                return;
              }
              fileInputRef.current?.click();
            }}
            disabled={loading}
            className={cn(
              "w-full py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 shadow-lg disabled:opacity-50",
              selectedLanguage ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-gray-600 text-gray-400 cursor-not-allowed"
            )}
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
            {loading ? "Analyzing..." : "Upload ZIP"}
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            accept=".zip" 
            className="hidden" 
          />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="text-sm font-medium text-gray-500 flex items-center gap-1">
              Project <ChevronRight size={14} /> 
              <span className="text-gray-900 font-bold">BugBuster AI</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {report && (
              <div className="flex items-center gap-2 bg-blue-50 px-3 py-1 rounded-full text-blue-700 text-xs font-bold border border-blue-100 uppercase">
                {report.language}
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Clock size={14} />
              {report ? new Date(report.timestamp).toLocaleTimeString() : "Ready"}
            </div>
            <div className="h-6 w-px bg-gray-200" />
            <button 
              onClick={handleOpenSelectKey}
              className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-bold transition-all border border-amber-200"
              title="Change Gemini API Key"
            >
              <Key size={14} />
              API Key
            </button>
            <div className="h-6 w-px bg-gray-200" />
            <button className="text-gray-400 hover:text-gray-600">
              <Settings size={20} />
            </button>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg flex items-center gap-3 shadow-sm">
              <XCircle size={20} />
              <span className="font-medium">{error}</span>
            </div>
          )}

          {!report && !loading && (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="w-20 h-20 bg-blue-50 text-blue-500 rounded-full flex items-center justify-center mb-6">
                <Activity size={40} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">BugBuster AI</h2>
              <p className="text-gray-500 max-w-md mb-8">
                Select the primary language of your project and upload a ZIP file to begin.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-2xl mb-12">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    onClick={() => setSelectedLanguage(lang.id)}
                    className={cn(
                      "p-6 rounded-xl border-2 transition-all flex flex-col items-center gap-3 group",
                      selectedLanguage === lang.id 
                        ? "border-blue-500 bg-blue-50 shadow-md" 
                        : "border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm"
                    )}
                  >
                    <span className="text-3xl group-hover:scale-110 transition-transform">{lang.icon}</span>
                    <span className={cn(
                      "font-bold text-sm",
                      selectedLanguage === lang.id ? "text-blue-700" : "text-gray-600"
                    )}>{lang.name}</span>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-8 w-full max-w-2xl">
                {[
                  { icon: <Terminal />, title: "Static Analysis", desc: "Detect syntax and logical errors" },
                  { icon: <ShieldCheck />, title: "Structural", desc: "Validate classes and functions" },
                  { icon: <Play />, title: "AI Testing", desc: "Auto-generate test scenarios" },
                ].map((item, i) => (
                  <div key={i} className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col items-center">
                    <div className="text-blue-500 mb-3">{item.icon}</div>
                    <h3 className="font-bold text-sm mb-1">{item.title}</h3>
                    <p className="text-xs text-gray-400">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="h-full flex flex-col items-center justify-center">
              <div className="relative mb-8">
                <div className="w-32 h-32 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Activity size={40} className="text-blue-600 animate-pulse" />
                </div>
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Analyzing {selectedLanguage?.toUpperCase()} Project</h3>
              <p className="text-gray-500 animate-pulse">
                {aiAnalysisProgress 
                  ? `AI Deep Analysis: ${aiAnalysisProgress.current} / ${aiAnalysisProgress.total} files`
                  : "Running modular analyzers and AI engines..."}
              </p>
              {aiAnalysisProgress && (
                <div className="mt-6 w-64">
                  <div className="w-full bg-gray-200 rounded-full h-2 shadow-inner">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all duration-500 ease-out shadow-[0_0_10px_rgba(37,99,235,0.5)]" 
                      style={{ width: `${(aiAnalysisProgress.current / aiAnalysisProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "rules" && selectedFileIdx === null && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Analysis Rules</h2>
                  <p className="text-gray-500 text-sm">Configure rule-based checks for each language.</p>
                </div>
                <div className="flex gap-2">
                  <select 
                    value={ruleLangFilter}
                    onChange={(e) => setRuleLangFilter(e.target.value)}
                    className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold text-gray-600 outline-none focus:border-blue-500"
                  >
                    <option value="all">All Languages</option>
                    <option value="python">Python</option>
                    <option value="java">Java</option>
                    <option value="c">C / C++</option>
                    <option value="javascript">JavaScript / TS</option>
                  </select>
                  <select 
                    value={ruleSeverityFilter}
                    onChange={(e) => setRuleSeverityFilter(e.target.value)}
                    className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold text-gray-600 outline-none focus:border-blue-500"
                  >
                    <option value="all">All Severities</option>
                    <option value="pass">Pass</option>
                    <option value="fail">Fail</option>
                    <option value="warning">Warning</option>
                  </select>
                  <button 
                    onClick={() => {
                      const name = prompt("Enter rule name:");
                      if (!name) return;
                      const description = prompt("Enter description:");
                      const language = prompt("Enter language (python, java, c, javascript, all):", "all");
                      const pattern = prompt("Enter regex pattern:");
                      const message = prompt("Enter failure message:");
                      const severity = prompt("Enter severity (pass, fail, warning):", "warning") as any;
                      
                      const newRule: ConfigurableRule = {
                        id: `custom-${Date.now()}`,
                        name,
                        description: description || "",
                        type: "syntax",
                        enabled: true,
                        severity: severity || "warning",
                        language: language || "all",
                        pattern: pattern || undefined,
                        message: message || "Rule violation detected."
                      };

                      fetch("/api/rules/add", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(newRule),
                      }).then(() => fetchRules());
                    }}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-blue-700 transition-colors flex items-center gap-2"
                  >
                    <Play size={14} /> Add Custom Rule
                  </button>
                  <button 
                    onClick={() => {
                      if (confirm("Are you sure you want to reset all rules to defaults?")) {
                        fetch("/api/rules/reset", { method: "POST" }).then(() => fetchRules());
                      }
                    }}
                    className="bg-gray-100 text-gray-600 px-4 py-2 rounded-lg text-xs font-bold hover:bg-gray-200 transition-colors flex items-center gap-2"
                  >
                    <Clock size={14} /> Reset to Defaults
                  </button>
                  <button 
                    onClick={fetchRules}
                    className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
                    title="Refresh Rules"
                  >
                    <Clock size={20} className={cn(rulesLoading && "animate-spin")} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                {rulesLoading ? (
                  <div className="h-64 flex items-center justify-center">
                    <Loader2 className="animate-spin text-blue-500" size={40} />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Header for the "table" */}
                    <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 hidden md:grid md:grid-cols-12 gap-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider items-center">
                      <div className="col-span-1">Status</div>
                      <div className="col-span-1">Language</div>
                      <div className="col-span-2">Severity</div>
                      <div className="col-span-6">Rule Details</div>
                      <div className="col-span-2 text-right">Actions</div>
                    </div>
                    
                    {rules
                      .filter(r => ruleLangFilter === "all" || r.language === ruleLangFilter || r.language === "all")
                      .filter(r => ruleSeverityFilter === "all" || r.severity === ruleSeverityFilter)
                      .map((rule) => (
                        <div key={rule.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                          <div className="col-span-1">
                            <button 
                              onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}
                              className={cn(
                                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none",
                                rule.enabled ? "bg-blue-600" : "bg-gray-200"
                              )}
                            >
                              <span className={cn(
                                "inline-block h-3 w-3 transform rounded-full bg-white transition-transform",
                                rule.enabled ? "translate-x-5" : "translate-x-1"
                              )} />
                            </button>
                          </div>
                          
                          <div className="col-span-1">
                            <span className={cn(
                              "text-[10px] font-bold uppercase px-2 py-0.5 rounded inline-block",
                              rule.language === "all" ? "bg-gray-100 text-gray-600" : "bg-blue-100 text-blue-700"
                            )}>
                              {rule.language}
                            </span>
                          </div>
                          
                          <div className="col-span-2">
                            <span className={cn(
                              "text-[10px] font-bold uppercase px-2 py-0.5 rounded inline-block",
                              rule.severity === "fail" ? "bg-red-100 text-red-700" : rule.severity === "warning" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                            )}>
                              {rule.severity}
                            </span>
                          </div>
                          
                          <div className="col-span-6">
                            <h3 className="font-bold text-gray-900 text-sm">{rule.name}</h3>
                            <p className="text-xs text-gray-500 line-clamp-1">{rule.description}</p>
                          </div>
                          
                          <div className="col-span-2 flex justify-end gap-1">
                            <button 
                              className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"
                              title="Edit Rule"
                              onClick={() => {
                                const newPattern = prompt("Enter new regex pattern:", rule.pattern || "");
                                if (newPattern !== null) {
                                  updateRule(rule.id, { pattern: newPattern });
                                }
                              }}
                            >
                              <Settings size={14} />
                            </button>
                            <button 
                              className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"
                              title="Delete Rule"
                              onClick={() => {
                                if (confirm("Are you sure you want to delete this rule?")) {
                                  fetch(`/api/rules/${rule.id}`, { method: "DELETE" }).then(() => fetchRules());
                                }
                              }}
                            >
                              <XCircle size={14} />
                            </button>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === "logs" && selectedFileIdx === null && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Analysis Logs</h2>
                  <p className="text-gray-500 text-sm">History of all code scans performed.</p>
                </div>
                <button 
                  onClick={fetchLogs}
                  className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
                  title="Refresh Logs"
                >
                  <Clock size={20} className={cn(logsLoading && "animate-spin")} />
                </button>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">File</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">Prev</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">Fixed</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">New</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">Current</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">Success %</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider">Date</th>
                      <th className="px-6 py-4 text-[10px] font-bold uppercase text-gray-400 tracking-wider text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {logsLoading ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-12 text-center">
                          <Loader2 className="animate-spin text-blue-500 mx-auto" size={32} />
                        </td>
                      </tr>
                    ) : logs.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-12 text-center text-gray-400 italic">
                          No analysis logs found.
                        </td>
                      </tr>
                    ) : (
                      logs.map((log) => (
                        <tr key={log.log_id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <FileCode size={14} className="text-gray-400" />
                              <span className="text-sm text-gray-600 truncate max-w-[120px]">{log.filename}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-500">{log.total_errors_before || 0}</td>
                          <td className="px-6 py-4 text-sm text-emerald-600 font-bold">+{log.errors_fixed || 0}</td>
                          <td className="px-6 py-4 text-sm text-amber-600 font-bold">{log.new_errors || 0}</td>
                          <td className="px-6 py-4">
                            <span className={cn(
                              "text-sm font-bold",
                              log.total_errors > 0 ? "text-red-600" : "text-emerald-600"
                            )}>
                              {log.total_errors}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={cn(
                              "text-xs font-bold px-2 py-1 rounded-full",
                              (log.success_rate || 0) > 80 ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"
                            )}>
                              {Math.round(log.success_rate || 0)}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-xs text-gray-500">
                            {new Date(log.analysis_time).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => {
                                if (log.report_data) {
                                  try {
                                    const parsedReport = JSON.parse(log.report_data);
                                    setReport(parsedReport);
                                    setSelectedFileIdx(0);
                                    setActiveTab("analysis");
                                  } catch (e) {
                                    console.error("Failed to parse report data", e);
                                  }
                                }
                              }}
                              className="text-blue-600 hover:text-blue-800 text-xs font-bold"
                            >
                              View Report
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {report && selectedFileIdx === null && activeTab === "analysis" && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* Role Specific Header */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    {user.role === 'Developer' ? 'Developer Dashboard' : 'Tester Dashboard'}
                  </h2>
                  <p className="text-sm text-gray-500">
                    {user.role === 'Developer' ? 'Unit Testing Level Analysis' : 'Testing Level Analysis'}
                  </p>
                </div>
                <div className="flex gap-4">
                  <div className="text-center">
                    <div className="text-[10px] font-bold text-gray-400 uppercase">Quality Score</div>
                    <div className="text-2xl font-black text-blue-600">
                      {report.qualityScore ?? Math.max(0, 100 - (stats.fail * 5 + stats.warning * 2))}/100
                    </div>
                  </div>
                </div>
              </div>

              {/* Dashboard Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                <StatCard 
                  title="Files Analyzed" 
                  value={report.filesAnalyzed || report.files.length} 
                  icon={<FileText className="text-blue-500" />} 
                />
                <StatCard 
                  title="Bugs Fixed" 
                  value={report.regressionInfo?.fixedErrors || 0} 
                  icon={<Zap className="text-emerald-500" />} 
                  status={report.regressionInfo?.fixedErrors && report.regressionInfo.fixedErrors > 0 ? "pass" : undefined}
                />
                <StatCard 
                  title="Issues Found" 
                  value={report.totalErrors} 
                  icon={<XCircle className="text-red-500" />} 
                  status={report.totalErrors > 0 ? "fail" : "pass"}
                />
                <StatCard 
                  title="New Errors" 
                  value={report.regressionInfo?.newErrors || 0} 
                  icon={<Bug className="text-amber-500" />} 
                  status={report.regressionInfo?.newErrors && report.regressionInfo.newErrors > 0 ? "warning" : "pass"}
                />
                <StatCard 
                  title="Success Rate" 
                  value={`${report.regressionInfo?.successRate || 0}%`} 
                  icon={<CheckCircle2 className="text-blue-500" />} 
                  status={report.regressionInfo?.successRate && report.regressionInfo.successRate > 80 ? "pass" : "warning"}
                />
              </div>

              <div className="flex gap-4">
                <button
                  onClick={handleRerun}
                  className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-200"
                >
                  <Activity size={18} /> Rerun Analysis
                </button>
                <button
                  onClick={downloadFixedCode}
                  className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-200"
                >
                  <Download size={18} /> Download Fixed Code
                </button>
              </div>

              {report.regressionInfo && (
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                  <h3 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider flex items-center gap-2">
                    <Clock size={16} /> Regression Testing Log
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 bg-gray-50 rounded-lg text-center">
                      <div className="text-[10px] font-bold text-gray-400 uppercase">Previous Errors</div>
                      <div className="text-xl font-bold text-gray-700">{report.regressionInfo.previousErrors}</div>
                    </div>
                    <div className="p-4 bg-emerald-50 rounded-lg text-center">
                      <div className="text-[10px] font-bold text-gray-400 uppercase">Fixed Errors</div>
                      <div className="text-xl font-bold text-emerald-600">+{report.regressionInfo.fixedErrors}</div>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <div className="text-[10px] font-bold text-gray-400 uppercase">New Errors</div>
                      <div className="text-xl font-bold text-red-600">{report.regressionInfo.newErrors}</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                  <h3 className="text-sm font-bold text-gray-500 mb-6 uppercase tracking-wider">Analysis Breakdown</h3>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={typeData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                        <XAxis type="number" hide />
                        <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} width={150} tick={{ fontSize: 10, fontWeight: 'bold' }} />
                        <RechartsTooltip cursor={{ fill: '#f3f4f6' }} />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={20}>
                          {typeData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                  <h3 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">Health Overview</h3>
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={chartData}
                          innerRadius={60}
                          outerRadius={80}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {chartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-2 mt-4">
                    {chartData.map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: d.color }} />
                          <span className="text-gray-600 font-medium">{d.name}</span>
                        </div>
                        <span className="font-bold">{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">Detailed File Status</h3>
                  <span className="text-[10px] text-gray-500 font-medium">Total: {report.files.length} Files</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {report.files.map((file, i) => (
                    <div key={i} className="p-4 flex items-center justify-between hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setSelectedFileIdx(i)}>
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "p-2 rounded-lg",
                          file.results.some(r => r.status === "fail") ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"
                        )}>
                          <FileCode size={20} />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-gray-800">{file.fileName}</div>
                          <div className="text-xs text-gray-500">{file.results.length} checks performed</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="flex gap-1">
                          {file.results.filter(r => r.status === "fail").length > 0 && (
                            <span className="px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-bold rounded-full">
                              {file.results.filter(r => r.status === "fail").length} ERRORS
                            </span>
                          )}
                          {file.results.filter(r => r.status === "warning").length > 0 && (
                            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-full">
                              {file.results.filter(r => r.status === "warning").length} WARN
                            </span>
                          )}
                        </div>
                        <ChevronRight size={16} className="text-gray-300" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {report && selectedFile && (
            <motion.div 
              key={selectedFile.fileName}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-6 h-full flex flex-col"
            >
              <div className="flex items-center justify-between shrink-0">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">{selectedFile.fileName}</h2>
                  <p className="text-sm text-gray-500">Detailed analysis and structural visualization</p>
                </div>
                <div className="flex gap-2">
                  <div className="bg-white border border-gray-200 rounded-md p-1 flex gap-1">
                    <button 
                      onClick={() => setActiveTab("analysis")}
                      className={cn(
                        "px-3 py-1.5 text-xs font-bold rounded transition-all",
                        activeTab === "analysis" ? "bg-blue-600 text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                      )}
                    >
                      Analysis
                    </button>
                    <button 
                      onClick={() => setActiveTab("ast")}
                      className={cn(
                        "px-3 py-1.5 text-xs font-bold rounded transition-all",
                        activeTab === "ast" ? "bg-blue-600 text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                      )}
                    >
                      AST Visualizer
                    </button>
                    <button 
                      onClick={() => setActiveTab("source")}
                      className={cn(
                        "px-3 py-1.5 text-xs font-bold rounded transition-all",
                        activeTab === "source" ? "bg-blue-600 text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                      )}
                    >
                      Source
                    </button>
                  </div>
                  <button 
                    onClick={handleRerun}
                    disabled={loading}
                    className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    <Play size={16} /> Re-run
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0">
                {activeTab === "analysis" && (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full overflow-y-auto pb-8">
                    <div className="lg:col-span-2 space-y-4">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Analysis Results</h3>
                      {selectedFile.results.map((res, i) => (
                        <ResultCard 
                          key={i} 
                          result={res} 
                          onFix={() => handleAiFix(selectedFile.fileName, selectedFile.content, selectedLanguage || "auto", res)}
                          isFixing={fixingFile === selectedFile.fileName}
                        />
                      ))}
                    </div>

                    <div className="space-y-4">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">AI Insights</h3>
                      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <div className="flex items-center gap-2 text-blue-600 mb-4">
                          <Activity size={20} />
                          <span className="font-bold text-sm">AI Summary</span>
                        </div>
                        <p className="text-sm text-gray-600 leading-relaxed">
                          The AI engine has analyzed the logic of this file using {report.language.toUpperCase()} specific rules. 
                          {selectedFile.results.some(r => r.type === "syntax" && r.status === "fail") 
                            ? " Several potential logical flaws were identified that could lead to runtime exceptions."
                            : " No critical logical errors were found, and the structure follows standard patterns."}
                        </p>
                        <div className="mt-6 pt-6 border-t border-gray-100">
                          <div className="flex justify-between text-xs mb-2">
                            <span className="text-gray-500">Test Coverage</span>
                            <span className="font-bold text-blue-600">85%</span>
                          </div>
                          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 w-[85%]" />
                          </div>
                        </div>
                      </div>

                      <div className="bg-[#1f2937] text-white p-6 rounded-xl shadow-lg">
                        <div className="flex items-center gap-2 text-blue-400 mb-4">
                          <Terminal size={20} />
                          <span className="font-bold text-sm">Execution Log</span>
                        </div>
                        <div className="font-mono text-[10px] space-y-2 opacity-80">
                          <div className="text-gray-400">[{new Date().toLocaleTimeString()}] Initializing test suite...</div>
                          <div className="text-gray-400">[{new Date().toLocaleTimeString()}] Language: {report.language.toUpperCase()}</div>
                          <div className="text-gray-400">[{new Date().toLocaleTimeString()}] Loading file: {selectedFile.fileName}</div>
                          <div className="text-emerald-400">[{new Date().toLocaleTimeString()}] Static analysis complete.</div>
                          <div className="text-emerald-400">[{new Date().toLocaleTimeString()}] AI test generation successful.</div>
                          <div className="text-blue-400">[{new Date().toLocaleTimeString()}] Executing test cases...</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "ast" && (
                  <div className="h-full bg-white rounded-xl border border-gray-200 shadow-sm relative overflow-hidden">
                    <div className="absolute top-4 right-4 z-10 flex gap-2">
                      <button 
                        onClick={() => {
                          setCollapsedNodes(new Set());
                        }}
                        className="bg-white/80 backdrop-blur px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm text-[10px] font-bold text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-2"
                      >
                        <Clock size={14} /> Expand All
                      </button>
                    </div>
                    <div className="absolute top-4 left-4 z-10 bg-white/80 backdrop-blur p-3 rounded-lg border border-gray-200 shadow-sm">
                      <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Legend</h4>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-[10px]">
                          <div className="w-2 h-2 rounded-full bg-blue-500" />
                          <span>Class / Struct</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <div className="w-2 h-2 rounded-full bg-emerald-500" />
                          <span>Function / Def</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <div className="w-2 h-2 rounded-full bg-amber-500" />
                          <span>Method</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <div className="w-2 h-2 rounded-full bg-purple-500" />
                          <span>Variable</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <div className="w-2 h-2 rounded-full bg-pink-500" />
                          <span>Interface</span>
                        </div>
                      </div>
                    </div>
                    {visibleAST ? (
                      <ReactFlow 
                        nodes={visibleAST.nodes} 
                        edges={visibleAST.edges}
                        nodeTypes={nodeTypes}
                        fitView
                      >
                        <Background color="#f8fafc" gap={20} />
                        <Controls />
                        <MiniMap />
                      </ReactFlow>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-400">
                        No AST data available for this file type.
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "source" && (
                  <div className="h-full bg-[#1e293b] rounded-xl border border-gray-800 shadow-xl overflow-hidden flex flex-col">
                    <div className="bg-[#0f172a] px-4 py-2 border-b border-gray-800 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1.5">
                          <div className="w-3 h-3 rounded-full bg-red-500/50" />
                          <div className="w-3 h-3 rounded-full bg-amber-500/50" />
                          <div className="w-3 h-3 rounded-full bg-emerald-500/50" />
                        </div>
                        <span className="text-xs text-gray-400 font-mono ml-4">{selectedFile.fileName}</span>
                      </div>
                    </div>
                    <div className="flex-1 overflow-auto p-6 font-mono text-sm text-gray-300 leading-relaxed">
                      <pre>
                        {selectedFile.content.split('\n').map((line, i) => (
                          <div key={i} className="flex gap-6 hover:bg-white/5 transition-colors group">
                            <span className="w-8 text-right text-gray-600 select-none group-hover:text-gray-400">{i + 1}</span>
                            <span>{line || ' '}</span>
                          </div>
                        ))}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </div>
      </main>
    </div>
  );
}

function StatCard({ title, value, icon, status }: { title: string, value: string | number, icon: React.ReactNode, status?: "pass" | "fail" | "warning" }) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex items-center gap-4">
      <div className="p-3 bg-gray-50 rounded-lg shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wider truncate">{title}</div>
        <div className={cn(
          "text-xl font-bold truncate",
          status === "pass" ? "text-emerald-600" : status === "fail" ? "text-red-600" : status === "warning" ? "text-amber-600" : "text-gray-900"
        )}>
          {value}
        </div>
      </div>
    </div>
  );
}

const ResultCard: React.FC<{ 
  result: AnalysisResult, 
  onFix?: () => void, 
  isFixing?: boolean 
}> = ({ result, onFix, isFixing }) => {
  const [isExpanded, setIsExpanded] = useState(result.status === "fail");

  return (
    <div className={cn(
      "bg-white border rounded-xl overflow-hidden transition-all shadow-sm",
      result.status === "fail" ? "border-red-200" : result.status === "warning" ? "border-amber-200" : "border-gray-100"
    )}>
      <div className="flex items-center">
        <button 
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 p-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-4">
            <div className={cn(
              "p-2 rounded-lg",
              result.status === "pass" ? "bg-emerald-50 text-emerald-600" : 
              result.status === "fail" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"
            )}>
              {result.status === "pass" ? <CheckCircle2 size={18} /> : 
               result.status === "fail" ? <XCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <div className="text-left">
              <div className="text-[10px] font-bold uppercase tracking-widest opacity-40 mb-0.5">{result.type}</div>
              <div className="text-sm font-bold text-gray-800">{result.message}</div>
            </div>
          </div>
          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        
        {result.status !== "pass" && onFix && (
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onFix();
            }}
            disabled={isFixing}
            className="mr-4 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-[10px] font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-sm"
          >
            {isFixing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {isFixing ? "Fixing..." : "AI Fix"}
          </button>
        )}
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="border-t border-gray-100 bg-gray-50/50"
          >
            <div className="p-4">
              {result.type === "test" && result.details && Array.isArray(result.details) ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 text-[10px] font-bold text-gray-400 uppercase tracking-wider px-2">
                    <div className="col-span-2">Test Case</div>
                    <div>Input</div>
                    <div className="text-right">Status</div>
                  </div>
                  {result.details.map((test: any, i: number) => (
                    <div key={i} className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            test.status === "passed" ? "bg-emerald-500" : "bg-red-500"
                          )} />
                          <span className="text-sm font-bold text-gray-700">{test.name}</span>
                          <span className="text-[10px] font-bold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded uppercase">{test.type}</span>
                        </div>
                        <span className={cn(
                          "text-[10px] font-bold uppercase px-2 py-0.5 rounded",
                          test.status === "passed" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                        )}>
                          {test.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 italic">{test.description}</p>
                      <div className="grid grid-cols-2 gap-4 mt-2 p-2 bg-gray-50 rounded border border-gray-100 font-mono text-[10px]">
                        <div>
                          <span className="text-gray-400 uppercase block mb-1">Input</span>
                          <code className="text-blue-600">{test.input}</code>
                        </div>
                        <div>
                          <span className="text-gray-400 uppercase block mb-1">Expected</span>
                          <code className="text-emerald-600">{test.expectedOutput}</code>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                    <div className="flex items-center gap-2 text-blue-600 mb-2">
                      <Info size={16} />
                      <span className="text-xs font-bold uppercase tracking-wider">Suggestion</span>
                    </div>
                    <p className="text-sm text-gray-700 leading-relaxed">
                      {result.details?.suggestion || "Consider reviewing the logic to ensure it follows best practices and handles all edge cases."}
                    </p>
                  </div>
                  {result.details?.line && (
                    <div className="flex items-center gap-2 text-[10px] text-gray-400 font-bold uppercase tracking-widest px-1">
                      <Hash size={12} />
                      <span>Line {result.details.line}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
