import {
  generateMidiMelody,
  generateChordProgression,
  generateDrumPattern,
  revealProjectFolder,
  explainImportToFlStudio,
  summarizeProjectContext,
  type ToolResult,
} from './midiTools';
import { searchFiles, getAllFiles } from './db';
import { shell } from 'electron';
import type { ProjectContext } from './copilotTypes';

// ── Tool Registry ─────────────────────────────────────────────────────────────

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  confirmationRequired: boolean;
  handler: (params: Record<string, unknown>, context: ProjectContext | null, opts?: { confirmedOutOfBand?: boolean }) => Promise<ToolResult & { status?: string; confirmationSummary?: string }>;
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
      const rows = (searchFiles(query, 20) as any[]).filter(f => {
        if (params.bpm && Math.abs((f.bpm ?? 0) - (params.bpm as number)) > 3) return false;
        if (params.key && !(f.key_note ?? '').toLowerCase().includes((params.key as string).toLowerCase())) return false;
        return true;
      });
      if (rows.length === 0) {
        return { status: 'done', message: `No local files found matching "${query}". Fields searched: filename, project name, role. Try a different name or run Discover to scan for new files.` };
      }
      const qLow = query.toLowerCase();
      const list = rows.slice(0, 5).map(f => {
        const matchReasons: string[] = [];
        if ((f.file_name ?? '').toLowerCase().includes(qLow)) matchReasons.push('name');
        if ((f.project_name ?? '').toLowerCase().includes(qLow)) matchReasons.push('project');
        if ((f.role ?? '').toLowerCase().includes(qLow)) matchReasons.push('role');
        if (params.bpm) matchReasons.push('BPM');
        if (params.key) matchReasons.push('key');
        const why = matchReasons.length ? ` [matched: ${matchReasons.join(', ')}]` : '';
        return `• ${f.file_name}${f.project_name ? ` (${f.project_name})` : ''}${f.bpm ? ` · ${f.bpm} BPM` : ''}${f.key_note ? ` · ${f.key_note}` : ''}${f.modified_at ? ` · ${new Date(f.modified_at).toLocaleDateString()}` : ''}${why}`;
      }).join('\n');
      return { status: 'done', message: `Found ${rows.length} file${rows.length !== 1 ? 's' : ''} (fields searched: filename, project, role):\n${list}`, data: rows };
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
      const rows = searchFiles(query, 3) as any[];
      if (!rows.length) {
        return { status: 'error', error: `Could not find "${query}" in your library. Try adding the file via the Library tab first.` };
      }
      const file = rows[0];
      // Validate file still exists on disk
      try { require('fs').statSync(file.file_path); } catch {
        return { status: 'error', error: `File "${file.file_name}" was moved or deleted. Path: ${file.file_path}` };
      }
      // Only open files that are actually in the indexed library (already confirmed via DB lookup)
      shell.openPath(file.file_path);
      return { status: 'done', message: `Opening "${file.file_name}" in your default app.\n(Matched by: name search for "${query}")`, filePath: file.file_path };
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
      const rows = searchFiles(query, 3) as any[];
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

/**
 * Registers the Phase H project tools (search_files, open_in_daw,
 * inspect_sync_status, sync_project, publish_version). Called once from
 * main.ts after the sync agent exists; deps are injected to avoid circular
 * imports and to keep the tool modules testable. Idempotent.
 */
export function registerProjectTools(tools: RegisteredTool[]) {
  for (const tool of tools) {
    if (!TOOL_REGISTRY.some((t) => t.name === tool.name)) TOOL_REGISTRY.push(tool);
  }
}

// ── LLM Agent Loop ────────────────────────────────────────────────────────────

const API_BASE = 'https://wavi.stream/api';

export interface PendingToolConfirmation {
  tool: string;
  params: Record<string, unknown>;
  summary: string;
}
export type AgentChatReply = string | { content: string; pendingConfirmation: PendingToolConfirmation };

export async function runAgentChat(
  messages: Array<{ role: string; content: string }>,
  context: ProjectContext | null,
  authToken: string | null
): Promise<AgentChatReply> {
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
            // Note: no opts passed — the model can never confirm its own call.
            const result = await tool.handler(params, context);
            if ((result as any).status === 'needs_confirmation') {
              return {
                content: result.message ?? 'This action needs your confirmation.',
                pendingConfirmation: {
                  tool: tool.name,
                  params,
                  summary: (result as any).confirmationSummary ?? `Confirm: ${tool.name}`,
                },
              };
            }
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

  // "open [track name]" or "play [track name]"
  const openMatch = low.match(/^(?:open|play|load)\s+(.+)/);
  if (openMatch) {
    const query = openMatch[1].trim();
    const tool = getToolByName('open_local_file')!;
    const result = await tool.handler({ query }, context);
    return result.message ?? result.error ?? null;
  }

  // "show me / reveal / find in folder [track name]"
  const revealMatch = low.match(/^(?:show|reveal|find in folder|show me|find)\s+(.+)/);
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

  // "find tracks" / "search for" / "any tracks with"
  const findMatch = low.match(/(?:find|search for|do i have|any tracks?|look for)\s+(.+)/);
  if (findMatch) {
    const query = findMatch[1].trim();
    const tool = getToolByName('search_local_files')!;
    const result = await tool.handler({ query }, context);
    return result.message ?? null;
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
    if (context.versionId) lines.push(`Selected version: ${context.versionId}`);
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
