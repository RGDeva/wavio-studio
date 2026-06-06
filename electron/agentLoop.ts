import {
  generateMidiMelody,
  generateChordProgression,
  generateDrumPattern,
  revealProjectFolder,
  explainImportToFlStudio,
  summarizeProjectContext,
  type ToolResult,
} from './midiTools';
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
];

export function getToolByName(name: string): RegisteredTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

// ── LLM Agent Loop ────────────────────────────────────────────────────────────

const API_BASE = 'https://wavi.stream/api';

export async function runAgentChat(
  messages: Array<{ role: string; content: string }>,
  context: ProjectContext | null,
  authToken: string | null
): Promise<string> {
  // Try cloud LLM first
  if (authToken) {
    try {
      const systemPrompt = buildSystemPrompt(context);
      const response = await fetch(`${API_BASE}/assistant/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          model: 'gpt-4o-mini',
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const data = await response.json() as { content?: string; choices?: Array<{ message: { content: string } }> };
        return data.content ?? data.choices?.[0]?.message?.content ?? fallbackResponse(messages, context);
      }
    } catch {
      // Fallback to local
    }
  }
  return fallbackResponse(messages, context);
}

function buildSystemPrompt(context: ProjectContext | null): string {
  const lines = [
    'You are Wavi Copilot, an AI assistant for music producers.',
    'You help with DAW workflows, MIDI generation, mix decisions, and project organization.',
    'Keep responses concise and actionable. Speak like a knowledgeable producer, not a corporate assistant.',
  ];
  if (context?.projectName) {
    lines.push(`\nActive project: ${context.projectName}`);
    if (context.dawType) lines.push(`DAW: ${context.dawType}`);
    lines.push(`Versions: ${context.versionCount}`);
    lines.push(`Files: ${context.files?.length ?? 0}`);
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
