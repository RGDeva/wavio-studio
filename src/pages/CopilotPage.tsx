import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Zap, Trash2, BookOpen, Plus, ScanSearch, Loader2, X } from 'lucide-react';
import { api } from '../lib/api';

interface Msg { id: string; role: 'user'|'assistant'; content: string; ts: string; }

interface DiscoveryProgress {
  phase: 'scanning' | 'importing' | 'done' | 'cancelled' | 'limit_reached';
  scanned?: number;
  found?: number;
  imported?: number;
  duplicates?: number;
  permissionErrors?: number;
  currentDir?: string;
}

const PROMPTS = [
  'What have I been working on recently?',
  'Open my latest mix',
  'Find all my stems from last week',
  'What BPM is my project?',
  'Pre-release checklist for this project',
  'Generate a trap chord progression in Am',
];

// Human-readable search capability disclaimer shown in empty state
const SEARCH_NOTE = 'Searches filename, project name, role, BPM, and key — not audio content.';

export function CopilotPage({ visible }: { visible?: boolean }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [memories, setMemories] = useState<any[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<{ tool: string; params: Record<string, unknown>; summary: string; ctx: any } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (visible) { inputRef.current?.focus(); loadMemories(); } }, [visible]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Listen for discovery progress events from main process
  useEffect(() => {
    const handler = (progress: unknown) => {
      setDiscoveryProgress(progress as DiscoveryProgress);
    };
    api.on('discovery:progress', handler);
    return () => api.off('discovery:progress', handler);
  }, []);

  const loadMemories = useCallback(async () => {
    try { setMemories(await api.memory.list()); } catch {}
  }, []);

  const send = useCallback(async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    setInput('');
    const userMsg: Msg = { id: crypto.randomUUID(), role: 'user', content, ts: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    try {
      const ctx = await api.copilot.getContext().catch(() => null);
      const history = [...messages, userMsg].map(m => ({ role: m.role as 'user'|'assistant', content: m.content }));
      const reply = await api.copilot.chat(history, ctx).catch(() => 'Copilot unavailable — ensure you are signed in.' as const);
      if (typeof reply === 'object' && reply !== null && 'pendingConfirmation' in reply) {
        // Gated tool: show the confirmation card. Nothing has executed yet —
        // the envelope enforces this in the main process.
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: reply.content, ts: new Date().toISOString() }]);
        setPendingConfirm({ ...reply.pendingConfirmation, ctx });
      } else {
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: reply as string, ts: new Date().toISOString() }]);
      }
      await api.memory.set('last_chat', content, 'context').catch(() => {});
    } catch {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: 'Error reaching Copilot. Check your connection.', ts: new Date().toISOString() }]);
    }
    setLoading(false);
  }, [input, loading, messages]);

  const handleConfirm = async () => {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const r = await api.copilot.confirmTool(pendingConfirm.tool, pendingConfirm.params, pendingConfirm.ctx);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: r.message ?? r.error ?? (r.status === 'done' ? 'Done.' : 'Something went wrong.'),
        ts: new Date().toISOString(),
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${(e as Error)?.message ?? 'unknown'}`, ts: new Date().toISOString() }]);
    } finally {
      setPendingConfirm(null);
      setConfirmBusy(false);
    }
  };

  const handleCancelConfirm = () => {
    // Explicit cancel: the gated action never runs.
    setPendingConfirm(null);
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: 'Cancelled — no action was taken.', ts: new Date().toISOString() }]);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const saveMemory = async () => {
    if (!newKey.trim() || !newVal.trim()) return;
    await api.memory.set(newKey.trim(), newVal.trim(), 'note');
    setNewKey(''); setNewVal('');
    loadMemories();
  };

  const deleteMemory = async (key: string) => {
    await api.memory.delete(key);
    loadMemories();
  };

  const handleDiscoverAll = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryProgress({ phase: 'scanning', scanned: 0, found: 0 });
    try {
      const result = await api.files.discoverAll();
      const parts: string[] = [];
      parts.push(`Scan complete in ${(result.durationMs / 1000).toFixed(1)}s.`);
      parts.push(`Scanned ${result.scanned.toLocaleString()} files, found ${result.found.toLocaleString()} audio files.`);
      if (result.imported > 0) parts.push(`Imported ${result.imported} new file${result.imported !== 1 ? 's' : ''}.`);
      if (result.duplicates > 0) parts.push(`${result.duplicates} already in library (skipped).`);
      if (result.permissionErrors > 0) parts.push(`${result.permissionErrors} folder${result.permissionErrors !== 1 ? 's' : ''} could not be read (permission denied).`);
      if (result.limitReached) parts.push('File limit reached — some files may not have been scanned. You can raise the limit in Settings.');
      if (result.cancelled) parts.push('Scan was cancelled.');
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant' as const,
        content: parts.join(' '),
        ts: new Date().toISOString(),
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant' as const,
        content: 'Scan failed. Make sure the app has Full Disk Access in System Settings → Privacy & Security → Full Disk Access.',
        ts: new Date().toISOString(),
      }]);
    }
    setDiscovering(false);
    setDiscoveryProgress(null);
  }, []);

  const handleCancelDiscover = useCallback(async () => {
    await api.files.discoverCancel();
  }, []);

  const progressLabel = (() => {
    if (!discoveryProgress) return '';
    const p = discoveryProgress;
    if (p.phase === 'scanning') return `Scanning… ${(p.scanned ?? 0).toLocaleString()} files checked, ${(p.found ?? 0)} audio found`;
    if (p.phase === 'importing') return `Importing ${(p.found ?? 0)} files…`;
    return '';
  })();

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan-400" />
            <h1 className="text-base font-semibold text-white">Wavi Copilot</h1>
          </div>
          <div className="flex items-center gap-2">
            {discovering ? (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-white/30 max-w-[200px] truncate">{progressLabel}</span>
                <button
                  onClick={handleCancelDiscover}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-white/10 text-red-400/70 hover:text-red-400 transition-colors"
                >
                  <X className="w-3 h-3" />Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={handleDiscoverAll}
                title="Scan Mac for audio files"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 transition-all"
              >
                <ScanSearch className="w-3.5 h-3.5" />
                Discover
              </button>
            )}
            <button onClick={() => setShowMemory(s => !s)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-all ${showMemory?'bg-cyan-500/20 text-cyan-300 border-cyan-500/30':'text-white/40 border-white/10 hover:text-white/70'}`}>
              <BookOpen className="w-3.5 h-3.5" />Memory
            </button>
            <button onClick={() => setMessages([])} className="text-white/25 hover:text-white/60 transition-colors p-1.5 rounded-lg hover:bg-white/5">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="py-6">
              <div className="text-center mb-5">
                <Zap className="w-8 h-8 text-cyan-400/40 mx-auto mb-2" />
                <p className="text-white/30 text-sm font-medium">Wavi Copilot</p>
                <p className="text-white/15 text-xs mt-1">{SEARCH_NOTE}</p>
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {PROMPTS.map(p => (
                  <button key={p} onClick={() => send(p)}
                    className="w-full text-left px-4 py-2.5 rounded-xl bg-white/3 hover:bg-white/6 border border-white/5 hover:border-cyan-500/20 text-sm text-white/50 hover:text-white/80 transition-all">
                    {p}
                  </button>
                ))}
              </div>
              <p className="text-center text-[10px] text-white/15 mt-4">
                Hit <span className="font-mono bg-white/5 px-1 rounded">Discover</span> to scan your Mac for audio files first
              </p>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={`flex ${m.role==='user'?'justify-end':'justify-start'}`}>
              <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm whitespace-pre-wrap ${m.role==='user'?'bg-cyan-500/20 text-white rounded-br-sm':'bg-white/5 text-white/85 rounded-bl-sm'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-white/5 px-4 py-3 rounded-2xl rounded-bl-sm flex gap-1">
                {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 bg-white/30 rounded-full animate-bounce" style={{animationDelay:`${i*0.15}s`}} />)}
              </div>
            </div>
          )}
          {pendingConfirm && (
            <div className="mx-1 my-2 bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 space-y-3" role="alertdialog" aria-label="Confirm Copilot action">
              <p className="text-xs font-semibold text-amber-300">
                Copilot wants to run: <span className="font-mono">{pendingConfirm.tool.replace(/_/g, ' ')}</span>
              </p>
              <p className="text-xs text-white/70 leading-relaxed">{pendingConfirm.summary}</p>
              <div className="text-[10px] text-white/35 space-y-0.5">
                {pendingConfirm.ctx?.projectName && <p>Project: {pendingConfirm.ctx.projectName}</p>}
                {typeof pendingConfirm.ctx?.files?.length === 'number' && <p>Files in project: {pendingConfirm.ctx.files.length}</p>}
                {pendingConfirm.ctx?.versionId && <p>Selected version: {pendingConfirm.ctx.versionId}</p>}
                <p>{pendingConfirm.tool === 'publish_version'
                  ? 'Publishing uploads a snapshot to your Wavi account.'
                  : 'This may use significant network bandwidth.'}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button onClick={handleCancelConfirm} disabled={confirmBusy}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/60 hover:text-white/90 border border-white/10">
                  Cancel
                </button>
                <button onClick={handleConfirm} disabled={confirmBusy}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 disabled:opacity-40">
                  {confirmBusy ? 'Running…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="flex-shrink-0 px-6 pb-6 pt-2">
          <div className="flex gap-2 items-end bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus-within:border-cyan-500/30 transition-all">
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
              placeholder="Ask about your project, find tracks, get mix advice…"
              rows={1} className="flex-1 bg-transparent text-sm text-white placeholder-white/25 resize-none focus:outline-none leading-relaxed" />
            <button onClick={() => send()} disabled={!input.trim() || loading}
              className="flex-shrink-0 w-8 h-8 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-30 rounded-xl flex items-center justify-center transition-all">
              <Send className="w-3.5 h-3.5 text-black" />
            </button>
          </div>
          <p className="text-[10px] text-white/15 mt-1.5 text-center">⌘⇧W for overlay · Enter to send · Shift+Enter for newline</p>
        </div>
      </div>

      {showMemory && (
        <div className="w-72 flex-shrink-0 border-l border-white/5 flex flex-col">
          <div className="flex-shrink-0 px-4 py-4 border-b border-white/5">
            <h2 className="text-sm font-semibold text-white">Memory</h2>
            <p className="text-xs text-white/30 mt-0.5">Copilot remembers these</p>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {memories.length === 0 && <p className="text-xs text-white/20 py-4 text-center">No memories yet</p>}
            {memories.map(m => (
              <div key={m.key} className="flex items-start gap-2 group">
                <div className="flex-1 min-w-0 bg-white/3 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-white/35 truncate">{m.key}</p>
                  <p className="text-xs text-white/70 mt-0.5 line-clamp-2">{m.value}</p>
                </div>
                <button onClick={() => deleteMemory(m.key)} className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1 text-white/25 hover:text-red-400 transition-all">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 px-4 py-3 border-t border-white/5 space-y-2">
            <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="Key"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/25 focus:outline-none focus:border-cyan-500/30" />
            <input value={newVal} onChange={e => setNewVal(e.target.value)} placeholder="Value"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/25 focus:outline-none focus:border-cyan-500/30" />
            <button onClick={saveMemory} className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white transition-all">
              <Plus className="w-3 h-3" />Save Memory
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
