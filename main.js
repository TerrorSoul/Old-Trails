const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const keytar = require('keytar');
const DiscordRPC = require('discord-rpc');
const store = new Store();

const DEBUG_MODE = false;

const isPackaged = app.isPackaged;
const isWindows = process.platform === 'win32';
const resourcesPath = isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname;

const depotDownloaderExecutable = isWindows ? 'DepotDownloader.exe' : 'DepotDownloader';
const steamApiLib = isWindows ? 'steam_api64.dll' : 'libsteam_api.so';

const KEYTAR_SERVICE = 'trailmakers-downloader';
let mainWindow;
let downloadProcess;
let activeGameProcess = null;
let activeGameVersionName = null;
let gameStartTime;

// --- Discord RPC Setup ---
const DISCORD_CLIENT_ID = '1386680522356424756';
const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcReady = false;

async function setActivity(details, state) {
    if (!rpcReady) {
        return;
    }
    rpc.setActivity({
        details,
        state,
        startTimestamp: gameStartTime,
        largeImageKey: 'trailmakers-logo',
        largeImageText: 'Old Trails',
        instance: false,
    }).catch(console.error);
}

const TRAILMAKERS_APP_ID = '585420';
const TRAILMAKERS_DEPOT_ID = '585421';
const trailmakersVersions = [
    { name: "1.6 Wings and Weapons", manifestId: "5048626106885406615" },
    { name: "1.5 Decals", manifestId: "6418274266282092041" },
    { name: "1.4.2 Mirror Mode", manifestId: "8084832536635904913" },
    { name: "1.3 Mod Makers", manifestId: "752294084919392246" },
    { name: "1.2 Perfect Pitch", manifestId: "7125249926418413647" },
    { name: "1.1 Summer Party", manifestId: "7622037960763500709" },
    { name: "1.0.4 Centrifuge", manifestId: "7797596154752996883" },
    { name: "1.0 Release", manifestId: "2589706790386909403" },
    { name: "0.8.1 Tailwind", manifestId: "2174733110758165403" },
    { name: "0.8.0 Rally", manifestId: "6322044058692429718" },
    { name: "0.7.3 Happy Holidays", manifestId: "1401415892018513847" },
    { name: "0.7.2 The Danger Zone", manifestId: "6509328320731640329" },
    { name: "0.7.0 BLOCKS! BLOCKS! BLOCKS!", manifestId: "292833379719092558" },
    { name: "0.6.1 Logic Update", manifestId: "5774605827881735611" },
    { name: "0.6 Summer Update", manifestId: "8321905748150428964" },
    { name: "0.5.2 Submarine (Water Update #2)", manifestId: "4254061677353968400" },
    { name: "0.5.1 Build A Boat (Water Update #1)", manifestId: "5339152136185287284" },
    { name: "0.5 The Quality Update", manifestId: "9110008508980233200" },
    { name: "0.4.2 Race Island", manifestId: "4955326297487392530" },
    { name: "0.4.1 Rings of Fire", manifestId: "2127974181683886289" },
    { name: "0.4.0 Early Access", manifestId: "4365140693703019383" },
    { name: "Alpha Demo", manifestId: "1105845463103535907" },
];

// --- HELPER FUNCTIONS ---
const getSafeFolderName = (versionName) => `Trailmakers ${versionName.replace(/['":]/g, '')}`;

const copyDirRecursive = (src, dest) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
        const srcFile = path.join(src, file);
        const destFile = path.join(dest, file);
        const stat = fs.lstatSync(srcFile);
        if (stat.isDirectory()) {
            copyDirRecursive(srcFile, destFile);
        } else {
            fs.copyFileSync(srcFile, destFile);
        }
    }
};

const mergeDirRecursive = (src, dest) => {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    for (const file of fs.readdirSync(src)) {
        const srcFile = path.join(src, file);
        const destFile = path.join(dest, file);
        const stat = fs.lstatSync(srcFile);
        if (stat.isDirectory()) {
            mergeDirRecursive(srcFile, destFile);
        } else {
            if (!fs.existsSync(destFile)) {
               fs.copyFileSync(srcFile, destFile);
            }
        }
    }
};

const clearDir = (dirPath, exceptions = []) => {
    if (!fs.existsSync(dirPath)) return;
    for (const file of fs.readdirSync(dirPath)) {
        if (exceptions.includes(file)) continue;
        const fullPath = path.join(dirPath, file);
        try {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (error) {
            console.error(`Failed to delete ${fullPath}:`, error);
        }
    }
};

function findFileRecursive(startPath, filter) {
    let results = [];
    if (!fs.existsSync(startPath)) {
        console.log("Directory not found:", startPath);
        return [];
    }
    const files = fs.readdirSync(startPath);
    for (const file of files) {
        const filename = path.join(startPath, file);
        const stat = fs.lstatSync(filename);
        if (stat.isDirectory()) {
            results = results.concat(findFileRecursive(filename, filter));
        } else if (filename.endsWith(filter)) {
            results.push(filename);
        }
    }
    return results;
}

// --- SAVE MANAGEMENT LOGIC ---
const LOCAL_LOW_PATH = path.join(app.getPath('appData'), '..', 'LocalLow', 'Flashbulb', 'Trailmakers');
const DOCUMENTS_PATH = path.join(app.getPath('documents'), 'TrailMakers');
const OLD_TRAILS_ROOT_PATH = path.join(app.getPath('documents'), 'OldTrails');
const MAIN_BACKUP_PATH = path.join(OLD_TRAILS_ROOT_PATH, '_MainBackup');

const backupMainSave = () => {
    if (!isWindows) return;
    console.log('Backing up main Trailmakers save data...');
    try {
        if (fs.existsSync(MAIN_BACKUP_PATH)) {
            fs.rmSync(MAIN_BACKUP_PATH, { recursive: true, force: true });
        }
        fs.mkdirSync(path.join(MAIN_BACKUP_PATH, 'LocalLow'), { recursive: true });
        fs.mkdirSync(path.join(MAIN_BACKUP_PATH, 'Documents'), { recursive: true });

        if (fs.existsSync(LOCAL_LOW_PATH)) copyDirRecursive(LOCAL_LOW_PATH, path.join(MAIN_BACKUP_PATH, 'LocalLow'));
        if (fs.existsSync(DOCUMENTS_PATH)) copyDirRecursive(DOCUMENTS_PATH, path.join(MAIN_BACKUP_PATH, 'Documents'));
        console.log('Main save backup complete.');
    } catch (error) {
        console.error('Failed to create main save backup:', error);
        dialog.showErrorBox('Backup Error', `Could not create a backup of your main save files. Check permissions.\nError: ${error.message}`);
    }
};

const restoreMainSave = () => {
    if (!isWindows || !fs.existsSync(MAIN_BACKUP_PATH)) return;
    console.log('Restoring main Trailmakers save data...');
    try {
        clearDir(LOCAL_LOW_PATH);
        clearDir(DOCUMENTS_PATH, ['OldTrails']);

        copyDirRecursive(path.join(MAIN_BACKUP_PATH, 'LocalLow'), LOCAL_LOW_PATH);
        copyDirRecursive(path.join(MAIN_BACKUP_PATH, 'Documents'), DOCUMENTS_PATH);
        console.log('Main save restoration complete.');
    } catch (error) {
        console.error('Failed to restore main save backup:', error);
    }
};

const prepareVersionSave = (versionName, downloadPath) => {
    if (!isWindows) return;
    
    const safeVersionName = getSafeFolderName(versionName);
    const versionSavePath = path.join(downloadPath, safeVersionName, '_SaveData');
    const masterBackupBlueprintsPath = path.join(MAIN_BACKUP_PATH, 'Documents', 'Blueprints');
    const liveBlueprintsPath = path.join(DOCUMENTS_PATH, 'Blueprints');

    console.log(`Preparing save environment for ${versionName}...`);
    clearDir(LOCAL_LOW_PATH);
    clearDir(DOCUMENTS_PATH, ['OldTrails', 'Blueprints']);

    console.log('Syncing master blueprint collection to live directory...');
    mergeDirRecursive(masterBackupBlueprintsPath, liveBlueprintsPath);

    const versionSaveDocumentsPath = path.join(versionSavePath, 'Documents');
    const versionSaveLocalLowPath = path.join(versionSavePath, 'LocalLow');

    if (fs.existsSync(versionSavePath)) {
        console.log(`Restoring save data for ${versionName}.`);
        copyDirRecursive(versionSaveLocalLowPath, LOCAL_LOW_PATH);

        if (fs.existsSync(versionSaveDocumentsPath)) {
             for (const file of fs.readdirSync(versionSaveDocumentsPath)) {
                if (file === 'Blueprints') continue;
                const srcFile = path.join(versionSaveDocumentsPath, file);
                const destFile = path.join(DOCUMENTS_PATH, file);
                const stat = fs.lstatSync(srcFile);
                if (stat.isDirectory()) {
                    copyDirRecursive(srcFile, destFile);
                } else {
                    fs.copyFileSync(srcFile, destFile);
                }
            }
        }
        
        const versionBlueprintsPath = path.join(versionSaveDocumentsPath, 'Blueprints');
        if (fs.existsSync(versionBlueprintsPath)) {
            console.log(`Merging version-specific blueprints for ${versionName}.`);
            mergeDirRecursive(versionBlueprintsPath, liveBlueprintsPath);
        }
    } else {
        console.log(`No save data found for ${versionName}. Using master blueprints.`);
    }
};

const saveVersionSession = (versionName, downloadPath) => {
    if (!isWindows) return;

    const safeVersionName = getSafeFolderName(versionName);
    const versionSavePath = path.join(downloadPath, safeVersionName, '_SaveData');
    const liveBlueprintsPath = path.join(DOCUMENTS_PATH, 'Blueprints');
    const masterBackupBlueprintsPath = path.join(MAIN_BACKUP_PATH, 'Documents', 'Blueprints');
    
    console.log(`Saving session data for: ${versionName}`);
    try {
        if (fs.existsSync(versionSavePath)) {
           fs.rmSync(versionSavePath, { recursive: true, force: true });
        }
        fs.mkdirSync(path.join(versionSavePath, 'LocalLow'), { recursive: true });
        fs.mkdirSync(path.join(versionSavePath, 'Documents'), { recursive: true });

        copyDirRecursive(LOCAL_LOW_PATH, path.join(versionSavePath, 'LocalLow'));
        
        for(const file of fs.readdirSync(DOCUMENTS_PATH)) {
            if(file === 'Blueprints' || file === 'OldTrails') continue;
            const src = path.join(DOCUMENTS_PATH, file);
            const dest = path.join(versionSavePath, 'Documents', file);
            if(fs.lstatSync(src).isDirectory()) {
                copyDirRecursive(src, dest);
            } else {
                fs.copyFileSync(src, dest);
            }
        }

        console.log('Merging session blueprints into main backup...');
        if (fs.existsSync(liveBlueprintsPath)) {
            mergeDirRecursive(liveBlueprintsPath, masterBackupBlueprintsPath);
        }
        
        console.log('Saving updated blueprint collection to version save...');
        copyDirRecursive(masterBackupBlueprintsPath, path.join(versionSavePath, 'Documents', 'Blueprints'));

        console.log(`Session for ${versionName} saved successfully.`);
    } catch (error) {
        console.error(`Failed to save session for ${versionName}:`, error);
        dialog.showErrorBox('Save Error', `Could not save session data for ${versionName}.\nError: ${error.message}`);
    }
};

// --- WINDOW MANAGEMENT & APP LIFECYCLE ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 850,
        height: 650,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        resizable: false, 
        icon: path.join(__dirname, 'icon.png')
    });
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
    createWindow();
    backupMainSave();
});

app.on('window-all-closed', () => {
    if (downloadProcess) downloadProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    rpc.destroy();
});

// --- IPC HANDLERS ---
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('maximize-window', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('close-window', () => {
    if (activeGameProcess) {
        dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Game Still Running',
            message: 'A version of Trailmakers is still running. Please close it before closing the launcher.',
            buttons: ['OK']
        });
        return;
    }
    restoreMainSave();
    mainWindow.close();
});

ipcMain.handle('get-credentials', async () => {
    const username = store.get('username', '');
    const defaultPath = path.join(OLD_TRAILS_ROOT_PATH, 'Versions');
    const downloadPath = store.get('downloadPath', defaultPath);
    
    if (!fs.existsSync(downloadPath)) {
        try { fs.mkdirSync(downloadPath, { recursive: true }); } 
        catch (error) { console.error(`Failed to create directory ${downloadPath}:`, error); }
    }
    
    let password = null;
    if (username) password = await keytar.getPassword(KEYTAR_SERVICE, username);
    return { username, password, downloadPath };
});

ipcMain.on('ui-ready', (event) => {
    event.reply('versions-loaded', trailmakersVersions);
    event.reply('debug-mode-status', DEBUG_MODE);
    event.reply('platform-info', process.platform); 
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (!result.canceled) {
        const selectedPath = result.filePaths[0];
        store.set('downloadPath', selectedPath);
        return selectedPath;
    }
    return null;
});

ipcMain.handle('get-installed-versions', (event, downloadPath) => {
    if (!downloadPath || !fs.existsSync(downloadPath)) return [];
    const installed = [];
    try {
        const directories = fs.readdirSync(downloadPath, { withFileTypes: true });
        for (const version of trailmakersVersions) {
            const folderName = getSafeFolderName(version.name);
            if (directories.some(dir => dir.isDirectory() && dir.name === folderName)) {
                installed.push(version.manifestId);
            }
        }
    } catch (error) {
        console.error("Failed to scan for installed versions:", error);
    }
    return installed;
});

ipcMain.on('launch-game', async (event, { downloadPath, versionName }) => {
    const folderName = getSafeFolderName(versionName);
    const versionPath = path.join(downloadPath, folderName);

    if (!fs.existsSync(versionPath)) {
        return dialog.showErrorBox('Launch Error', `Could not find game directory:\n${versionPath}`);
    }
    
    prepareVersionSave(versionName, downloadPath);

    const exePath = isWindows ? path.join(versionPath, 'Trailmakers.exe') : versionPath;
    
    if (isWindows && !fs.existsSync(exePath)) {
        return dialog.showErrorBox('Launch Error', `Could not find Trailmakers.exe:\n${exePath}`);
    }

    try {
        activeGameProcess = spawn(exePath, [], { detached: true, stdio: 'ignore' });
        activeGameVersionName = versionName;
        gameStartTime = new Date();
        setActivity('Playing Trailmakers', `Version: ${versionName}`);
        mainWindow.webContents.send('game-launched', versionName);
        
        activeGameProcess.on('close', (code) => {
            console.log(`Trailmakers process for ${versionName} exited with code ${code}`);
            saveVersionSession(versionName, downloadPath);
            console.log('Game closed. Restoring main save data immediately.');
            restoreMainSave();
            gameStartTime = null;
            setActivity('Browsing old versions', 'In the launcher');
            mainWindow.webContents.send('status-update', `${versionName} session saved. Main save restored.`);

            activeGameProcess = null;
            activeGameVersionName = null;
            mainWindow.webContents.send('game-closed');
        });

        activeGameProcess.on('error', (err) => {
            dialog.showErrorBox('Launch Error', `Failed to start Trailmakers.\nError: ${err.message}`);
            activeGameProcess = null;
            activeGameVersionName = null;
            gameStartTime = null;
            setActivity('Browsing old versions', 'In the launcher');
            mainWindow.webContents.send('game-closed');
        });

    } catch(err) {
        dialog.showErrorBox('Launch Error', `Could not start Trailmakers.\nError: ${err.message}`);
    }
});

ipcMain.handle('uninstall-version', async (event, { downloadPath, versionName }) => {
    if (activeGameVersionName === versionName) {
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Cannot Uninstall',
            message: 'This version of Trailmakers is currently running.',
            detail: 'Please close the game before trying to uninstall it.'
        });
        return { success: false, message: 'Uninstall failed: game is running.' };
    }

    const folderName = getSafeFolderName(versionName);
    const fullPath = path.join(downloadPath, folderName);
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Uninstall'], defaultId: 0, cancelId: 0,
        title: 'Confirm Uninstall', message: `Are you sure you want to permanently delete ${versionName}?`,
        detail: `This will delete the folder and all its contents:\n${fullPath}`
    });
    if (result.response === 1) {
        try {
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                
                const remainingVersions = fs.readdirSync(downloadPath).filter(file => {
                    const stat = fs.lstatSync(path.join(downloadPath, file));
                    return stat.isDirectory() && !file.startsWith('_temp_');
                });

                if (remainingVersions.length === 0) {
                    console.log('Last version uninstalled. Restoring main save data.');
                    restoreMainSave();
                    return { success: true, message: 'Last version uninstalled. Main save restored.' };
                }

                return { success: true, message: `${versionName} has been uninstalled.` };
            }
            return { success: false, message: 'Folder not found.' };
        } catch (error) {
            dialog.showErrorBox('Uninstall Error', `An error occurred during uninstallation.\nError: ${error.message}`);
            return { success: false, message: 'An error occurred during uninstallation.' };
        }
    }
    return { success: false, message: 'Uninstall cancelled by user.' };
});

ipcMain.handle('factory-reset', async () => {
    if (activeGameProcess) {
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Cannot Reset',
            message: 'A version of Trailmakers is currently running.',
            detail: 'Please close the game before starting a factory reset.'
        });
        return { success: false, message: 'Reset failed: game is running.' };
    }

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Yes, Delete Everything'],
        defaultId: 0,
        cancelId: 0,
        title: 'Confirm Factory Reset',
        message: 'Are you absolutely sure?',
        detail: 'This will permanently delete all downloaded versions and their save data. Your main game save will be restored from the initial backup. This action cannot be undone.'
    });

    if (result.response === 1) {
        try {
            const defaultPath = path.join(OLD_TRAILS_ROOT_PATH, 'Versions');
            const downloadPath = store.get('downloadPath', defaultPath);

            console.log(`Performing factory reset. Deleting: ${downloadPath}`);
            if (fs.existsSync(downloadPath)) {
                fs.rmSync(downloadPath, { recursive: true, force: true });
            }
            fs.mkdirSync(downloadPath, { recursive: true });
            restoreMainSave();
            return { success: true, message: 'Factory reset complete. All versions removed.' };
        } catch (error) {
            console.error('Factory reset failed:', error);
            dialog.showErrorBox('Reset Error', `An error occurred during the factory reset.\nError: ${error.message}`);
            return { success: false, message: 'An error occurred during the reset.' };
        }
    }
    return { success: false, message: 'Factory reset cancelled.' };
});

ipcMain.on('start-download', async (event, { username, password, version, downloadPath }) => {
    if (downloadProcess) {
        return event.reply('status-update', 'A download is already in progress.');
    }
    setActivity('Downloading', version.name);
    store.set('username', username);
    await keytar.setPassword(KEYTAR_SERVICE, username, password);
    const sendStatus = (message) => event.reply('status-update', message);
    const depotDownloaderExePath = path.join(resourcesPath, depotDownloaderExecutable);
    const tempDownloadDir = path.join(downloadPath, `_temp_${version.manifestId}`);
    if (fs.existsSync(tempDownloadDir)) fs.rmSync(tempDownloadDir, { recursive: true, force: true });
    fs.mkdirSync(tempDownloadDir, { recursive: true });
    const args = [
        '-app', TRAILMAKERS_APP_ID, '-depot', TRAILMAKERS_DEPOT_ID,
        '-manifest', version.manifestId, '-username', username,
        '-password', password, '-remember-password', '-dir', tempDownloadDir,
        '-validate', '-os', 'windows', '-osarch', '64', '-max-downloads', '16'
    ];
    downloadProcess = spawn(depotDownloaderExePath, args);
    let stderrOutput = ''; 
    const handleOutput = (data) => {
        const output = data.toString();
        
        if (output.includes('Use the Steam Mobile App to confirm your sign in...')) {
            sendStatus('Mobile confirmation required...');
            event.reply('steam-mobile-required');
        } else if (output.includes('Enter 2FA code:') || output.includes('Please enter your 2-factor auth code')) {
            sendStatus('Authentication required...');
            event.reply('steam-guard-required');
        } else if (output.includes('Logging')) sendStatus('Logging in to Steam...');
        else if (output.includes('Processing depot')) sendStatus('Processing depot information...');
        else if (output.includes('Downloading depot')) sendStatus('Starting file download...');
        else if (output.includes('Depot download complete')) sendStatus('Download complete, finalizing files...');
        
        const progressMatch = output.match(/(\d+\.\d+)%/);
        if (progressMatch && progressMatch[1]) {
            const progress = parseFloat(progressMatch[1]);
            event.reply('download-progress', { progress: Math.floor(progress) });
            sendStatus(`Downloading: ${progress.toFixed(2)}%`);
        }
    };
    downloadProcess.stdout.on('data', handleOutput);
    downloadProcess.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        handleOutput(data);
    });
    downloadProcess.on('close', (code) => {
        setActivity('Browsing old versions', 'In the launcher');
        setTimeout(() => {
            if (code === 0) {
                try {
                    const downloadedContentPath = tempDownloadDir;
                    const finalVersionPath = path.join(downloadPath, getSafeFolderName(version.name));
                    if (!fs.existsSync(path.join(downloadedContentPath, 'Trailmakers.exe'))) {
                         throw new Error(`Download finished, but Trailmakers.exe was not found.`);
                    }
                    fs.renameSync(downloadedContentPath, finalVersionPath);
                    const crackedApiLibPath = path.join(resourcesPath, 'steam_api64.dll');
                    sendStatus('Applying patch...');
                    const originalLibName = 'steam_api64.dll';
                    const results = findFileRecursive(finalVersionPath, originalLibName);
                    if (results && results.length > 0) {
                        fs.copyFileSync(crackedApiLibPath, results[0]);
                    } else {
                        fs.copyFileSync(crackedApiLibPath, path.join(finalVersionPath, originalLibName));
                    }
                    sendStatus('Installation Complete!');
                    event.reply('download-complete', { success: true, installedManifestId: version.manifestId });
                } catch (moveError) {
                    console.error("File move/patch error:", moveError);
                    sendStatus(`Error finalizing installation: ${moveError.message}`);
                    event.reply('download-complete', { success: false });
                }
            } else {
                const finalError = stderrOutput.trim() || `Process exited with code ${code}.`;
                sendStatus(`Download failed: ${finalError}`);
                event.reply('download-complete', { success: false });
            }
            downloadProcess = null;
        }, 500);
    });
});

ipcMain.on('submit-steam-guard', (event, code) => {
    if (downloadProcess) {
        downloadProcess.stdin.write(`${code}\n`);
    }
});

rpc.on('ready', () => {
    console.log('Discord RPC is ready.');
    rpcReady = true;
    setActivity('Browsing old versions', 'In the launcher');
});

if (DISCORD_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE') {
    rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(err => {
        console.error('Failed to connect to Discord RPC:', err);
    });
}