"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('waviCopilot', {
    close: () => electron_1.ipcRenderer.invoke('copilot:close'),
    getProjectContext: () => electron_1.ipcRenderer.invoke('copilot:getContext'),
    runTool: (toolName, params) => electron_1.ipcRenderer.invoke('copilot:runTool', toolName, params),
    chat: (messages, context) => electron_1.ipcRenderer.invoke('copilot:chat', messages, context),
    on: (channel, listener) => {
        const SAFE = new Set(['context:updated', 'copilot:tool:done']);
        if (!SAFE.has(channel))
            return;
        electron_1.ipcRenderer.on(channel, (_event, ...args) => listener(...args));
    },
    off: (channel, listener) => {
        const SAFE = new Set(['context:updated', 'copilot:tool:done']);
        if (!SAFE.has(channel))
            return;
        electron_1.ipcRenderer.removeListener(channel, listener);
    },
});
