import { ipcMain, dialog } from 'electron';
import { scanAbletonFolder, DawSnapshot } from './adapters/ableton';

// IPC surface only — all scan/detect/parse logic lives in the Ableton DAW
// adapter (electron/adapters/ableton.ts) since the Phase F extraction.

let _registered = false;

export function registerAbletonHandlers() {
  if (_registered) return;
  _registered = true;
  ipcMain.handle('ableton:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Ableton Project Folder',
      buttonLabel: 'Select Folder',
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const folderPath = result.filePaths[0];
    const snapshot = await scanAbletonFolder(folderPath);
    return { canceled: false, folderPath, snapshot };
  });

  ipcMain.handle('ableton:sync-to-cloud', async (_e, snapshot: DawSnapshot, authToken: string) => {
    if (!authToken) return { error: 'Not authenticated with Wavi' };

    try {
      const resp = await fetch('https://wavi.stream/api/daw-snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ snapshot }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return { error: `Sync failed: ${resp.status} ${body}` };
      }

      const result = await resp.json();
      return { success: true, cloudProjectId: result.projectId };
    } catch (err: any) {
      return { error: err.message };
    }
  });
}
