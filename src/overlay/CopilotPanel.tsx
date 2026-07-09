import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Zap, MessageSquare, ChevronDown, Loader2, Wand2, Brain } from 'lucide-react';
import type { ChatMessage as ChatMsg, ProjectContext, CopilotMode, ToolOutput } from './types';
import { ChatMessage } from './ChatMessage';
import { ProjectContext as ProjectContextPanel } from './ProjectContext';

declare global {
  interface Window {
    waviCopilot: {
      close: () => void;
      getProjectContext: () => Promise<ProjectContext | null>;
      runTool: (toolName: string, params: Record<string, unknown>) => Promise<ToolOutput>;
      chat: (messages: Array<{ role: string; content: string }>, context: ProjectContext | null) => Promise<string>;
      on: (channel: string, cb: (...args: unknown[]) => void) => void;
      off: (channel: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

const SUGGESTED_PROMPTS = [
  'Generate a dark melody in C minor at 140 BPM',
  'Make a trap drum pattern at 140 BPM',
  'Generate a chord progression in A minor',
  'How do I import this MIDI into FL Studio?',
  'What changed since the last version?',
  'Summarize this project',
];

function genId() {
  return Math.random().toString(36).slice(2);
}

const ACT_TOOLS = [
  { label: 'Melody', prompt: 'Generate a dark melody in C minor at 140 BPM' },
  { label: 'Chords', prompt: 'Generate a chord progression in A minor at 120 BPM' },
  { label: 'Drums', prompt: 'Make a trap drum pattern at 140 BPM' },
  { label: 'Open Folder', prompt: 'Reveal project folder' },
  { label: 'Summarize', prompt: 'Summarize this project' },
  { label: 'FL Import', prompt: 'How do I import this MIDI into FL Studio?' },
];

export function CopilotPanel() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<CopilotMode>('ask');
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const [sending, setSending] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copilot = (window as any).waviCopilot as typeof window.waviCopilot | undefined;

  // Load project context on mount — FIXED: no-copilot guard + 5s timeout prevents infinite spinner
  useEffect(() => {
    if (!copilot) {
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    const timeout = setTimeout(() => setContextLoading(false), 5000);
    copilot.getProjectContext()
      .then((ctx) => {
        clearTimeout(timeout);
        setContext(ctx);
        setContextLoading(false);
        if (ctx?.projectName) {
          addSystemMessage(`Loaded project: ${ctx.projectName}`);
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        setContextLoading(false);
      });
    return () => clearTimeout(timeout);
  }, []);

  // Refresh context on watcher events
  useEffect(() => {
    if (!copilot) return;
    const refresh = () => {
      copilot.getProjectContext().then(setContext).catch(() => {});
    };
    copilot.on('context:updated', refresh);
    return () => copilot.off('context:updated', refresh);
  }, [copilot]);

  // Load memory count for badge
  useEffect(() => {
    const waviAPI = (window as any).waviAPI;
    if (!waviAPI?.memory?.list) return;
    waviAPI.memory.list().then((list: any[]) => setMemoryCount(list.length)).catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function addSystemMessage(content: string) {
    setMessages((prev) => [
      ...prev,
      { id: genId(), role: 'system', content, timestamp: new Date().toISOString() },
    ]);
  }

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending || !copilot) return;

    const userMsg: ChatMsg = {
      id: genId(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    const assistantId = genId();
    const thinkingMsg: ChatMsg = {
      id: assistantId,
      role: 'assistant',
      content: '…',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, thinkingMsg]);

    try {
      // Check if this is a tool invocation
      const lower = trimmed.toLowerCase();
      const toolOutputs: ToolOutput[] = [];
      let responseText = '';

      if (lower.includes('melody') || lower.includes('generate') && lower.includes('mel')) {
        const params = extractMidiParams(trimmed, 'melody');
        const out = await copilot.runTool('generate_midi_melody', params);
        toolOutputs.push(out);
        responseText = out.status === 'done'
          ? `Generated melody: ${out.filePath?.split('/').pop()}\n\n${out.description || ''}`
          : `Failed: ${out.error}`;
      } else if (lower.includes('chord')) {
        const params = extractMidiParams(trimmed, 'chord');
        const out = await copilot.runTool('generate_chord_progression', params);
        toolOutputs.push(out);
        responseText = out.status === 'done'
          ? `Generated chord progression: ${out.filePath?.split('/').pop()}\n\n${out.description || ''}`
          : `Failed: ${out.error}`;
      } else if (lower.includes('drum')) {
        const params = extractMidiParams(trimmed, 'drum');
        const out = await copilot.runTool('generate_drum_pattern', params);
        toolOutputs.push(out);
        responseText = out.status === 'done'
          ? `Generated drum pattern: ${out.filePath?.split('/').pop()}\n\n${out.description || ''}`
          : `Failed: ${out.error}`;
      } else if (lower.includes('import') || lower.includes('fl studio')) {
        const out = await copilot.runTool('explain_import_to_fl_studio', {});
        toolOutputs.push(out);
        responseText = out.description || '';
      } else if (lower.includes('folder') || lower.includes('reveal')) {
        const out = await copilot.runTool('reveal_project_folder', {});
        toolOutputs.push(out);
        responseText = out.description || 'Opened project folder.';
      } else if (lower.includes('summarize') || lower.includes('summary') || lower.includes('changed')) {
        const out = await copilot.runTool('summarize_project_context', {});
        toolOutputs.push(out);
        responseText = out.description || '';
      } else {
        // Free-form: send to LLM (or fallback)
        const reply = await copilot.chat(
          [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
          context
        );
        responseText = typeof reply === 'string'
          ? reply
          : `${(reply as any)?.content ?? ''}\n\nOpen the Copilot page in Wavi Studio to confirm this action.`;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: responseText, toolOutputs: toolOutputs.length ? toolOutputs : undefined }
            : m
        )
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${String(err)}` }
            : m
        )
      );
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [sending, copilot, context, messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <div
      className="flex flex-col h-screen bg-[#0a0a0a]/95 backdrop-blur-xl text-white rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
      style={{ fontFamily: 'Inter, sans-serif' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/8 flex-shrink-0">
        <div className="w-5 h-5 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
          <Zap className="w-3 h-3 text-cyan-400" />
        </div>
        <span className="text-sm font-semibold text-white/80">Wavi Copilot</span>
        <div className="flex items-center gap-1.5 ml-auto">
          {/* Memory badge */}
          {memoryCount > 0 && (
            <div className="flex items-center gap-1 bg-violet-500/15 border border-violet-500/20 rounded-full px-1.5 py-0.5" title={`${memoryCount} memories stored`}>
              <Brain className="w-2.5 h-2.5 text-violet-400" />
              <span className="text-[9px] text-violet-300">{memoryCount}</span>
            </div>
          )}
          {/* Ask / Act toggle */}
          <button
            onClick={() => setMode(m => m === 'ask' ? 'act' : 'ask')}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-all border ${
              mode === 'act'
                ? 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300'
                : 'bg-white/5 border-white/10 text-white/35 hover:text-white/60'
            }`}
            title={mode === 'act' ? 'Switch to Ask mode' : 'Switch to Act mode (quick tools)'}
          >
            {mode === 'act' ? <Wand2 className="w-2.5 h-2.5" /> : <MessageSquare className="w-2.5 h-2.5" />}
            {mode}
          </button>
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <button
            onClick={() => (window as any).waviCopilot?.close()}
            className="w-6 h-6 rounded-full flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Project Context (collapsible) */}
      <div className="flex-shrink-0 border-b border-white/6">
        <button
          onClick={() => setShowContext(!showContext)}
          className="w-full flex items-center justify-between px-4 py-2 text-[10px] text-white/30 hover:text-white/50 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            <MessageSquare className="w-3 h-3" />
            <span className="uppercase tracking-wider">Project Context</span>
            {context?.projectName && (
              <span className="text-cyan-400/60 ml-1">{context.projectName}</span>
            )}
            {contextLoading && <Loader2 className="w-3 h-3 text-cyan-400/60 animate-spin ml-1" />}
          </div>
          <ChevronDown className={`w-3 h-3 transition-transform ${showContext ? 'rotate-180' : ''}`} />
        </button>
        {showContext && (
          <ProjectContextPanel context={context} loading={contextLoading} />
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-thin scrollbar-thumb-white/10"
      >
        {messages.length === 0 && (
          <div className="text-center py-4">
            <p className="text-xs text-white/25 mb-4">Ask Wavi anything about your project</p>
            <div className="space-y-1.5">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  className="block w-full text-left text-[11px] text-white/35 hover:text-white/60 bg-white/3 hover:bg-white/6 border border-white/6 hover:border-white/12 rounded-lg px-3 py-2 transition-all"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
      </div>

      {/* Act mode quick tools */}
      {mode === 'act' && (
        <div className="flex-shrink-0 border-t border-white/6 px-3 py-2">
          <p className="text-[9px] text-white/20 uppercase tracking-wider mb-1.5">Quick Actions</p>
          <div className="flex flex-wrap gap-1">
            {ACT_TOOLS.map(t => (
              <button key={t.label} onClick={() => send(t.prompt)} disabled={sending}
                className="px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-cyan-500/15 border border-white/8 hover:border-cyan-500/25 text-white/50 hover:text-cyan-300 transition-all disabled:opacity-40">
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 border-t border-white/8 px-3 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={context?.projectName ? `Ask about ${context.projectName}…` : 'Ask Wavi anything…'}
            disabled={sending}
            rows={1}
            className="flex-1 bg-white/6 border border-white/10 rounded-xl px-3 py-2 text-xs text-white/80 placeholder-white/25 resize-none focus:outline-none focus:border-cyan-500/40 transition-colors disabled:opacity-50"
            style={{ minHeight: '36px', maxHeight: '120px' }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || sending}
            className="w-8 h-8 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all flex-shrink-0"
          >
            <Send className="w-3.5 h-3.5 text-black" />
          </button>
        </div>
        <p className="text-[9px] text-white/15 mt-1.5 text-center">
          ⌘⇧W to hide · Act mode coming soon
        </p>
      </div>
    </div>
  );
}

// Extract BPM/key/scale from natural language
function extractMidiParams(text: string, type: 'melody' | 'chord' | 'drum'): Record<string, unknown> {
  const bpmMatch = text.match(/(\d{2,3})\s*bpm/i);
  const bpm = bpmMatch ? parseInt(bpmMatch[1]) : 120;

  const keyMatch = text.match(/\b([A-G][#b]?)\s*(major|minor|maj|min|m\b)/i);
  const key = keyMatch ? keyMatch[1] : 'C';
  const isMinor = keyMatch ? /min/i.test(keyMatch[2]) : false;
  const scale = isMinor ? 'minor' : 'major';

  const barsMatch = text.match(/(\d+)\s*bars?/i);
  const bars = barsMatch ? parseInt(barsMatch[1]) : 4;

  if (type === 'drum') {
    const patternMatch = text.match(/\b(trap|house|techno|boom\s*bap|dnb|jungle|afrobeats|drill)\b/i);
    return { pattern_type: patternMatch?.[1]?.toLowerCase().replace(/\s+/, '_') ?? 'trap', tempo: bpm, bars };
  }
  if (type === 'chord') {
    const progMatch = text.match(/\b(i-v-vi-iv|vi-iv-i-v|i-iv-v|ii-v-i|i-vi-iv-v)\b/i);
    return { key, scale, progression: progMatch?.[1] ?? 'i-iv-v-i', tempo: bpm, bars };
  }
  return { key, scale, tempo: bpm, bars };
}
