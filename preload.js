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
    checkAndDownloadSteamCmd: () => ipcRenderer.invoke('check-and-download-steamcmd'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Listeners (main -> renderer)
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (_event, value) => callback(value)),
    onSteamGuardRequired: (callback) => ipcRenderer.on('steam-guard-required', () => callback()),
    onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (_event, value) => callback(value)),
    onVersionsLoaded: (callback) => ipcRenderer.on('versions-loaded', (_event, value) => callback(value)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, value) => callback(value)),
    
    onDebugModeStatus: (callback) => ipcRenderer.on('debug-mode-status', (_event, value) => callback(value)),
    onDebugLogUpdate: (callback) => ipcRenderer.on('debug-log-update', (_event, value) => callback(value)),

    // --- NEW: Listener for Platform Info ---
    onPlatformInfo: (callback) => ipcRenderer.on('platform-info', (_event, value) => callback(value)),


    // Cleanup
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
