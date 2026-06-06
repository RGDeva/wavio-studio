export interface DawSnapshot {
  id: string;
  source: 'ableton' | 'fl-studio' | 'logic' | 'pro-tools';
  sessionName: string;
  bpm: number;
  key: string;
  detectedFiles: DetectedFile[];
  metadata: {
    detectedAt: string;
    folderPath: string;
    abletonVersion?: string;
    projectType: 'song' | 'live-set' | 'template';
  };
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  cloudProjectId?: string;
}

export interface DetectedFile {
  path: string;
  name: string;
  type: 'als' | 'alc' | 'adg' | 'wav' | 'aiff' | 'mp3' | 'mid' | 'json';
  role: 'project' | 'clip' | 'preset' | 'audio' | 'midi' | 'analysis';
  size: number;
  modifiedAt: string;
  metadata?: {
    bpm?: number;
    key?: string;
    duration?: number;
    sampleRate?: number;
  };
}
