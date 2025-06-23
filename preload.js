const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    // Actions
    startDownload: (args) => ipcRenderer.send('start-download', args),
    submitSteamGuard: (code) => ipcRenderer.send('submit-steam-guard', code),
    uiReady: () => ipcRenderer.send('ui-ready'),
    launchGame: (args) => ipcRenderer.send('launch-game', args),

    // Invoke (request/response)
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getCredentials: () => ipcRenderer.invoke('get-credentials'),
    getInstalledVersions: (path) => ipcRenderer.invoke('get-installed-versions', path),
    uninstallVersion: (args) => ipcRenderer.invoke('uninstall-version', args),
    factoryReset: () => ipcRenderer.invoke('factory-reset'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Listeners (main -> renderer)
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (_event, value) => callback(value)),
    onSteamGuardRequired: (callback) => ipcRenderer.on('steam-guard-required', () => callback()),
    onSteamMobileRequired: (callback) => ipcRenderer.on('steam-mobile-required', () => callback()),
    onSteamEmailRequired: (callback) => ipcRenderer.on('steam-email-required', () => callback()),
    onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (_event, value) => callback(value)),
    onVersionsLoaded: (callback) => ipcRenderer.on('versions-loaded', (_event, value) => callback(value)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, value) => callback(value)),
    onGameLaunched: (callback) => ipcRenderer.on('game-launched', (_event, value) => callback(value)),
    onGameClosed: (callback) => ipcRenderer.on('game-closed', () => callback()),
    
    // Cleanup
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
