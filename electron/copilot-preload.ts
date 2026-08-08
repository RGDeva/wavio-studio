import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('waviCopilot', {
  close: () => ipcRenderer.invoke('copilot:close'),

  getProjectContext: (projectId?: string | null) => ipcRenderer.invoke('copilot:getContext', projectId ?? null),

  runTool: (toolName: string, params: Record<string, unknown>, projectId?: string | null) =>
    ipcRenderer.invoke('copilot:runTool', toolName, params, projectId ?? null),

  chat: (messages: Array<{ role: string; content: string }>, context: unknown) =>
    ipcRenderer.invoke('copilot:chat', messages, context),

  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const SAFE = new Set(['context:updated', 'copilot:tool:done']);
    if (!SAFE.has(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => listener(...args));
  },
  off: (channel: string, listener: (...args: unknown[]) => void) => {
    const SAFE = new Set(['context:updated', 'copilot:tool:done']);
    if (!SAFE.has(channel)) return;
    ipcRenderer.removeListener(channel, listener);
  },
});
