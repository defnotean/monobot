const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
    // Agent connection
    connect: () => ipcRenderer.invoke('connect-agent'),
    disconnect: () => ipcRenderer.invoke('disconnect-agent'),
    getStatus: () => ipcRenderer.invoke('get-status'),

    // Chat & Sub-agents
    chatIrene: (d) => ipcRenderer.invoke('chat-irene', d),
    spawnSubagent: (d) => ipcRenderer.invoke('spawn-subagent', d),

    // Terminal & Files
    runTerminal: (d) => ipcRenderer.invoke('run-terminal', d),
    readDir: (p) => ipcRenderer.invoke('read-dir', p),
    readFile: (p) => ipcRenderer.invoke('read-file', p),
    writeFile: (d) => ipcRenderer.invoke('write-file', d),
    openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),

    // Settings / API Keys
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfigKey: (d) => ipcRenderer.invoke('save-config-key', d),

    // GitHub
    githubLoadSaved: () => ipcRenderer.invoke('github-load-saved'),
    githubConnect: (t) => ipcRenderer.invoke('github-connect', t),
    githubRepos: () => ipcRenderer.invoke('github-repos'),
    githubClone: (d) => ipcRenderer.invoke('github-clone', d),
    githubPull: (p) => ipcRenderer.invoke('github-pull', p),
    githubStatus: (p) => ipcRenderer.invoke('github-status', p),
    githubDisconnect: () => ipcRenderer.invoke('github-disconnect'),

    // Window
    closeApp: () => ipcRenderer.send('close-app'),
    minimizeApp: () => ipcRenderer.send('minimize-app'),
    maximizeApp: () => ipcRenderer.send('maximize-app'),
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // Events
    onCommandStart: (cb) => ipcRenderer.on('agent-command-start', (_, d) => cb(d)),
    onCommandDone: (cb) => ipcRenderer.on('agent-command-done', (_, d) => cb(d)),
    onLog: (cb) => ipcRenderer.on('agent-log', (_, d) => cb(d)),
});
