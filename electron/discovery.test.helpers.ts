/**
 * Test-only re-exports from discovery.ts so tests can reach internal helpers
 * without making them part of the public API.
 */
import path from 'path';
import { AUDIO_EXTS } from './discovery';

export { AUDIO_EXTS };

const SKIP_DIRS = new Set([
  'node_modules', '.npm', '.yarn', '.pnp', 'bower_components',
  '.cargo', '.rustup', '__pycache__', 'venv', '.venv',
  'target', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  '.git', '.svn', '.hg',
  '.Trash', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
  '.TemporaryItems', '.DS_Store', 'System', 'private', 'usr',
  'com~apple~CloudDocs',
  'release', 'dist-electron', '.electron-gyp',
  'DerivedData', 'xcuserdata',
]);

export function shouldSkipDirTest(name: string, fullPath: string): boolean {
  if (name.startsWith('.')) return true;
  if (SKIP_DIRS.has(name)) return true;
  const ext = path.extname(name).toLowerCase();
  if (['.app', '.framework', '.bundle', '.xcodeproj', '.pkg'].includes(ext)) return true;
  if (name === 'release' && fullPath.includes('wavio')) return true;
  return false;
}
