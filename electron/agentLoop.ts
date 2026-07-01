import {
  generateMidiMelody,
  generateChordProgression,
  generateDrumPattern,
  revealProjectFolder,
  explainImportToFlStudio,
  summarizeProjectContext,
  type ToolResult,
} from './midiTools';
import { searchFiles, getAllFiles, semanticSearchFiles } from './db';
import { shell } from 'electron';
import type { ProjectContext } from './copilotTypes';

// ── Tool Registry ─────────────────────────────────────────────────────────────

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  confirmationRequired: boolean;
  handler: (params: Record<string, unknown>, context: ProjectContext | null) => Promise<ToolResult>;
}

export const TOOL_REGISTRY: RegisteredTool[] = [
  {
    name: 'generate_midi_melody',
    description: 'Generate a melodic MIDI file in a given key, scale, and tempo',
    parameters: {
      key:    { type: 'string', description: 'Root note (C, D, F#, etc.)' },
      scale:  { type: 'string', description: 'Scale type: major, minor, pentatonic, blues, dorian, phrygian' },
      tempo:  { type: 'number', description: 'BPM (40-300)' },
      bars:   { type: 'number', description: 'Number of bars (1-16)' },
    },
    confirmationRequired: false,
    handler: async (params, ctx) => generateMidiMelody({
      key: params.key as string,
      scale: params.scale as string,
      tempo: params.tempo as number,
      bars: params.bars as number,
      projectFolder: ctx?.filePath ? require('path').dirname(ctx.filePath) : null,
    }),
  },
  {
    name: 'generate_chord_progression',
    description: 'Generate a chord progression MIDI file',
    parameters: {
      key:         { type: 'string', description: 'Root note' },
      scale:       { type: 'string', description: 'major or minor' },
      progression: { type: 'string', description: 'Roman numeral progression e.g. i-VI-III-VII' },
      tempo:       { type: 'number', description: 'BPM' },
      bars:        { type: 'number', description: 'Number of bars' },
    },
    confirmationRequired: false,
    handler: async (params, ctx) => generateChordProgression({
      key: params.key as string,
      scale: params.scale as string,
      progression: params.progression as string,
      tempo: params.tempo as number,
      bars: params.bars as number,
      projectFolder: ctx?.filePath ? require('path').dirname(ctx.filePath) : null,
    }),
  },
  {
    name: 'generate_drum_pattern',
    description: 'Generate a drum pattern MIDI file in a given style',
    parameters: {
      pattern_type: { type: 'string', description: 'Style: trap, house, techno, boom_bap' },
      tempo:        { type: 'number', description: 'BPM' },
      bars:         { type: 'number', description: 'Number of bars (1-8)' },
    },
    confirmationRequired: false,
    handler: async (params, ctx) => generateDrumPattern({
      pattern_type: params.pattern_type as string,
      tempo: params.tempo as number,
      bars: params.bars as number,
      projectFolder: ctx?.filePath ? require('path').dirname(ctx.filePath) : null,
    }),
  },
  {
    name: 'reveal_project_folder',
    description: 'Open the active project folder or MIDI output folder in Finder/Explorer',
    parameters: {},
    confirmationRequired: false,
    handler: async (_params, ctx) => revealProjectFolder(
      ctx?.filePath ? require('path').dirname(ctx.filePath) : null
    ),
  },
  {
    name: 'explain_import_to_fl_studio',
    description: 'Explain how to import a generated MIDI file into FL Studio',
    parameters: {},
    confirmationRequired: false,
    handler: async () => explainImportToFlStudio(),
  },
  {
    name: 'summarize_project_context',
    description: 'Summarize the current project: versions, files, sync status',
    parameters: {},
    confirmationRequired: false,
    handler: async (_params, ctx) => summarizeProjectContext({
      projectName: ctx?.projectName ?? null,
      dawType: ctx?.dawType ?? null,
      versionCount: ctx?.versionCount ?? 0,
      fileCount: ctx?.files?.length ?? 0,
      lastSyncedAt: ctx?.lastSyncedAt ?? null,
      cloudVersions: ctx?.cloudProject?.versions?.map((v) => ({
        versionNumber: v.versionNumber,
        syncedAt: v.syncedAt,
      })),
    }),
  },
  {
    name: 'search_local_files',
    description: 'Search local music files by name, project, BPM, key, date, or role. Use this when the user asks to find a specific track or set of files.',
    parameters: {
      query: { type: 'string', description: 'Search term — file name, project name, or keywords' },
      bpm:   { type: 'number', description: 'Filter by BPM (optional)', required: false },
      key:   { type: 'string', description: 'Filter by musical key e.g. Am, G#, Cmaj (optional)', required: false },
    },
    confirmationRequired: false,
    handler: async (params, _ctx): Promise<ToolResult> => {
      const query = (params.query as string) ?? '';
      const { tokens, dateFilter } = parseSemanticQuery(query);
      // Fall back to original LIKE search if no useful tokens extracted
      let rows: any[];
      if (tokens.length > 0) {
        rows = semanticSearchFiles(tokens, dateFilter, 20) as any[];
        // Also try exact LIKE for the full query and merge without duplicates
        const exact = searchFiles(query, 20) as any[];
        const seen = new Set(rows.map((r: any) => r.id));
        exact.forEach((r: any) => { if (!seen.has(r.id)) rows.push(r); });
      } else {
        rows = searchFiles(query, 20) as any[];
      }
      rows = rows.filter((f: any) => {
        if (params.bpm && Math.abs((f.bpm ?? 0) - (params.bpm as number)) > 3) return false;
        if (params.key && !(f.key_note ?? '').toLowerCase().includes((params.key as string).toLowerCase())) return false;
        return true;
      });
      if (rows.length === 0) {
        return { status: 'done', message: `No local files found matching "${query}". Fields searched: filename, project name, role. Try a different name or run Discover to scan for new files.` };
      }
      const list = rows.slice(0, 5).map((f: any) =>
        `• ${f.file_name}${f.project_name ? ` (${f.project_name})` : ''}${f.bpm ? ` · ${f.bpm} BPM` : ''}${f.key_note ? ` · ${f.key_note}` : ''}${f.modified_at ? ` · ${new Date(f.modified_at).toLocaleDateString()}` : ''}`
      ).join('\n');
      return { status: 'done', message: `Found ${rows.length} file${rows.length !== 1 ? 's' : ''}:\n${list}`, data: rows };
    },
  },
  {
    name: 'open_local_file',
    description: 'Open a local audio or project file using its file path. Use this when the user says "open" or "play" a specific file.',
    parameters: {
      query: { type: 'string', description: 'File name or description to look up' },
    },
    confirmationRequired: false,
    handler: async (params, _ctx): Promise<ToolResult> => {
      const query = (params.query as string) ?? '';
      const { tokens, dateFilter } = parseSemanticQuery(query);
      let rows: any[];
      if (tokens.length > 0) {
        rows = semanticSearchFiles(tokens, dateFilter, 5) as any[];
        if (!rows.length) rows = searchFiles(query, 5) as any[];
      } else {
        rows = searchFiles(query, 5) as any[];
      }
      if (!rows.length) {
        return { status: 'error', error: `Could not find "${query}" in your library. Try adding the file via the Library tab first.` };
      }
      const file = rows[0];
      // Validate file still exists on disk
      try { require('fs').statSync(file.file_path); } catch {
        return { status: 'error', error: `File "${file.file_name}" was moved or deleted. Path: ${file.file_path}` };
      }
      shell.openPath(file.file_path);
      return { status: 'done', message: `Opening "${file.file_name}" in your default app.`, filePath: file.file_path };
    },
  },
  {
    name: 'reveal_local_file',
    description: 'Reveal a local file in Finder/Explorer. Use when user says "show me", "find in folder", or "reveal".',
    parameters: {
      query: { type: 'string', description: 'File name or description to look up' },
    },
    confirmationRequired: false,
    handler: async (params, _ctx): Promise<ToolResult> => {
      const query = (params.query as string) ?? '';
      const { tokens, dateFilter } = parseSemanticQuery(query);
      let rows: any[];
      if (tokens.length > 0) {
        rows = semanticSearchFiles(tokens, dateFilter, 3) as any[];
        if (!rows.length) rows = searchFiles(query, 3) as any[];
      } else {
        rows = searchFiles(query, 3) as any[];
      }
      if (!rows.length) {
        return { status: 'error', error: `Could not find "${query}" in your library.` };
      }
      const file = rows[0];
      try { require('fs').statSync(file.file_path); } catch {
        return { status: 'error', error: `File "${file.file_name}" was moved or deleted. Re-run Discover to update your library.` };
      }
      shell.showItemInFolder(file.file_path);
      return { status: 'done', message: `Revealing "${file.file_name}" in Finder.\n(Matched by: name search for "${query}")`, filePath: file.file_path };
    },
  },
  {
    name: 'list_recent_files',
    description: 'List the most recently modified local music files. Use when user asks "what have I been working on?" or "show my recent tracks".',
    parameters: {
      limit: { type: 'number', description: 'Max number of files to return (default 8)' },
    },
    confirmationRequired: false,
    handler: async (params, _ctx): Promise<ToolResult> => {
      const limit = Math.min((params.limit as number) ?? 8, 20);
      const rows = (getAllFiles(limit, 0) as any[]);
      if (!rows.length) {
        return { status: 'done', message: 'No files in your library yet. Drop some audio files into the Library tab to get started.' };
      }
      const list = rows.map(f =>
        `• ${f.file_name}${f.project_name ? ` (${f.project_name})` : ''}${f.bpm ? ` · ${f.bpm} BPM` : ''}${f.modified_at ? ` · ${new Date(f.modified_at).toLocaleDateString()}` : ''}`
      ).join('\n');
      return { status: 'done', message: `Your ${rows.length} most recent files:\n${list}` };
    },
  },
];

export function getToolByName(name: string): RegisteredTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

// ── Semantic query parser ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','my','your','our','their','his','her','its','this','that','these','those',
  'is','are','was','were','be','been','being','have','has','had','do','does','did','will',
  'would','could','should','may','might','shall','can','need','must','ought',
  'i','me','we','you','he','she','they','them','us',
  'in','on','at','from','to','of','for','with','by','about','as','into','through','over',
  'find','open','play','load','show','reveal','search','look','any','get','give','tell',
  'track','tracks','file','files','song','songs','project','projects','audio','sound',
  'latest','newest','recent','last','first','old','new','some','all',
  "rishi's","rishis",'rishi',
]);

const MONTH_MAP: Record<string, string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
  january:'01',february:'02',march:'03',april:'04',june:'06',
  july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',
};

/**
 * Parse a natural-language query into search tokens and an optional date filter.
 * Example: "open Rishi's track die this way from June 22"
 *   → tokens: ["die","way"], dateFilter: "2026-06-22" (uses current year)
 */
export function parseSemanticQuery(raw: string): { tokens: string[]; dateFilter: string | null } {
  const low = raw.toLowerCase().trim();

  // Extract date: "June 22", "jun 22", "22 june", "june 22 2025", "2025-06-22"
  let dateFilter: string | null = null;
  let cleaned = low;

  // ISO date
  const isoMatch = cleaned.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    dateFilter = isoMatch[0];
    cleaned = cleaned.replace(isoMatch[0], ' ');
  } else {
    // "Month DD [YYYY]" or "DD Month [YYYY]"
    const monthPattern = Object.keys(MONTH_MAP).join('|');
    const mdy = cleaned.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:\\s+(\\d{4}))?\\b`));
    const dmy = cleaned.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`));
    const match = mdy ?? dmy;
    if (match) {
      const monthStr = mdy ? match[1] : match[2];
      const dayStr = mdy ? match[2] : match[1];
      const yearStr = match[3] ?? String(new Date().getFullYear());
      const mo = MONTH_MAP[monthStr];
      if (mo) {
        dateFilter = `${yearStr}-${mo}-${dayStr.padStart(2, '0')}`;
        cleaned = cleaned.replace(match[0], ' ');
      }
    }
  }

  // Strip "from <date phrase>" leftovers like "from june" already consumed above
  cleaned = cleaned.replace(/\bfrom\b/g, ' ');

  // Tokenize: split on non-alpha, remove stopwords and short tokens
  const tokens = cleaned
    .split(/[^a-z0-9_]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));

  return { tokens, dateFilter };
}

// ── LLM Agent Loop ────────────────────────────────────────────────────────────

const API_BASE = 'https://wavi.stream/api';

export async function runAgentChat(
  messages: Array<{ role: string; content: string }>,
  context: ProjectContext | null,
  authToken: string | null
): Promise<string> {
  // Local intent detection first — handles find/open/reveal without LLM round-trip
  const localResult = await tryLocalIntent(messages, context);
  if (localResult !== null) return localResult;

  // Try cloud LLM
  if (authToken) {
    try {
      const systemPrompt = buildSystemPrompt(context);
      const tools = TOOL_REGISTRY.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
            ),
            required: Object.entries(t.parameters).filter(([, v]) => v.required !== false).map(([k]) => k),
          },
        },
      }));

      const response = await fetch(`${API_BASE}/assistant/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          model: 'gpt-4o-mini',
          max_tokens: 800,
          tools,
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const data = await response.json() as any;
        const choice = data.choices?.[0];

        // Handle tool call from LLM
        if (choice?.finish_reason === 'tool_calls' && choice?.message?.tool_calls?.length) {
          const tc = choice.message.tool_calls[0];
          const tool = getToolByName(tc.function.name);
          if (tool) {
            let params: Record<string, unknown> = {};
            try { params = JSON.parse(tc.function.arguments ?? '{}'); } catch {}
            const result = await tool.handler(params, context);
            return result.message ?? result.error ?? 'Done.';
          }
        }

        return data.content ?? choice?.message?.content ?? fallbackResponse(messages, context);
      }
    } catch {
      // Fallback to local
    }
  }
  return fallbackResponse(messages, context);
}

async function tryLocalIntent(
  messages: Array<{ role: string; content: string }>,
  context: ProjectContext | null
): Promise<string | null> {
  const last = messages.filter(m => m.role === 'user').pop()?.content ?? '';
  const low = last.toLowerCase();

  // "open / play / load [description]"
  const openMatch = low.match(/^(?:open|play|load)\s+(.+)/);
  if (openMatch) {
    const query = openMatch[1].trim();
    const tool = getToolByName('open_local_file')!;
    const result = await tool.handler({ query }, context);
    return result.message ?? result.error ?? null;
  }

  // "show me / reveal / find in folder [description]"
  const revealMatch = low.match(/^(?:show|reveal|find in folder|show me)\s+(.+)/);
  if (revealMatch) {
    const query = revealMatch[1].trim();
    const tool = getToolByName('reveal_local_file')!;
    const result = await tool.handler({ query }, context);
    return result.message ?? result.error ?? null;
  }

  // "what have i been working on" / "recent tracks"
  if (low.match(/recent|what.*work|last session|been working/)) {
    const tool = getToolByName('list_recent_files')!;
    const result = await tool.handler({ limit: 8 }, context);
    return result.message ?? null;
  }

  // "find tracks" / "search for" / "do i have" / "any tracks with"
  const findMatch = low.match(/(?:find|search for|do i have|any tracks?|look for)\s+(.+)/);
  if (findMatch) {
    const query = findMatch[1].trim();
    const tool = getToolByName('search_local_files')!;
    const result = await tool.handler({ query }, context);
    return result.message ?? null;
  }

  // Natural: "[name] from [date]" — no explicit verb but contains a date hint
  const { tokens, dateFilter } = parseSemanticQuery(low);
  if (dateFilter && tokens.length > 0) {
    const rows = semanticSearchFiles(tokens, dateFilter, 5) as any[];
    if (rows.length > 0) {
      const file = rows[0] as any;
      // If user seems to want to open it
      if (low.includes('open') || low.includes('play') || low.includes('load')) {
        try { require('fs').statSync(file.file_path); } catch {
          return `File "${file.file_name}" was moved or deleted.`;
        }
        shell.openPath(file.file_path);
        return `Opening "${file.file_name}"${file.modified_at ? ` (${new Date(file.modified_at).toLocaleDateString()})` : ''}.`;
      }
      // Otherwise list
      const list = rows.slice(0, 5).map((f: any) =>
        `• ${f.file_name}${f.project_name ? ` (${f.project_name})` : ''}${f.modified_at ? ` · ${new Date(f.modified_at).toLocaleDateString()}` : ''}`
      ).join('\n');
      return `Found ${rows.length} file${rows.length !== 1 ? 's' : ''} matching your query:\n${list}`;
    }
  }

  return null;
}

function buildSystemPrompt(context: ProjectContext | null): string {
  const lines = [
    'You are Wavi Copilot, an AI assistant for music producers.',
    'You help with: finding/opening local tracks, DAW workflows, MIDI generation, mix decisions, and project organization.',
    'When the user asks to find, open, play, or show a file — use search_local_files, open_local_file, or reveal_local_file tools.',
    'When the user asks what they worked on recently — use list_recent_files.',
    'Keep responses concise and actionable. Speak like a knowledgeable producer, not a corporate assistant.',
    `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
  ];
  if (context?.projectName) {
    lines.push(`\nActive project: ${context.projectName}`);
    if (context.dawType) lines.push(`DAW: ${context.dawType}`);
    lines.push(`Versions: ${context.versionCount}`);
    lines.push(`Files in project: ${context.files?.length ?? 0}`);
    if (context.lastSyncedAt) lines.push(`Last synced: ${context.lastSyncedAt}`);
  }
  return lines.join('\n');
}

function fallbackResponse(
  messages: Array<{ role: string; content: string }>,
  context: ProjectContext | null
): string {
  const last = messages.filter((m) => m.role === 'user').pop()?.content?.toLowerCase() ?? '';

  if (last.includes('what') && (last.includes('changed') || last.includes('version'))) {
    if (!context?.cloudProject?.versions?.length) {
      return 'No version history found. Make sure your project has been synced to Wavi.';
    }
    const v = context.cloudProject.versions[0];
    return `Latest version: v${v.versionNumber} synced on ${new Date(v.syncedAt).toLocaleDateString()}.`;
  }

  if (last.includes('release') || last.includes('before i drop') || last.includes('checklist')) {
    return [
      'Pre-release checklist:',
      '• Bounce a final stereo export at 24-bit / 44.1kHz',
      '• Check loudness: target -14 LUFS for streaming',
      '• True peak should be below -1 dBTP',
      '• Make sure all samples are cleared',
      '• Add metadata: title, BPM, key, genre',
      '• Upload to Wavi for provenance before distribution',
    ].join('\n');
  }

  if (context?.projectName) {
    return `I'm looking at your project "${context.projectName}". What do you need help with? I can generate MIDI, explain FL Studio import steps, summarize versions, or answer questions about mixing.`;
  }

  return 'No project is currently loaded. Open a DAW project or select a watched folder to get started. I can generate MIDI, explain workflows, and help you organize your sessions.';
}
