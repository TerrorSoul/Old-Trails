const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const keytar = require('keytar');
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

const getSafeFolderName = (versionName) => `Trailmakers ${versionName.replace(/['":]/g, '')}`;

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
    if (downloadProcess) downloadProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('maximize-window', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('close-window', () => mainWindow.close());

ipcMain.handle('get-credentials', async () => {
    const username = store.get('username', '');
    const defaultPath = path.join(app.getPath('documents'), 'Trailmakers Versions');
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

const getFlashbulbTrailmakersPath = () => {
    const appDataPath = app.getPath('appData');
    const localLowPath = path.join(appDataPath, '..', 'LocalLow');
    return path.join(localLowPath, 'Flashbulb', 'Trailmakers');
};

const getAppDataBackupPath = () => {
    const flashbulbTrailmakersPath = getFlashbulbTrailmakersPath();
    return path.join(flashbulbTrailmakersPath, '_backup');
};

const backupFlashbulbTrailmakers = () => {
    if (!isWindows) return true; 
    const sourcePath = getFlashbulbTrailmakersPath();
    const backupPath = getAppDataBackupPath();

    if (fs.existsSync(sourcePath) && fs.readdirSync(sourcePath).filter(name => name !== '_backup').length > 0) {
        try {
            fs.mkdirSync(backupPath, { recursive: true });
            fs.readdirSync(sourcePath).forEach(item => {
                const itemPath = path.join(sourcePath, item);
                const backupItemPath = path.join(backupPath, item);
                if (item === '_backup') return;
                if (fs.existsSync(backupItemPath)) fs.rmSync(backupItemPath, { recursive: true, force: true });
                fs.renameSync(itemPath, backupItemPath);
            });
            return true;
        } catch (error) {
            dialog.showErrorBox('Backup Error', `Could not backup Trailmakers profile data.\nError: ${error.message}`);
            return false;
        }
    }
    return true;
};

const restoreFlashbulbTrailmakers = () => {
    if (!isWindows) return true;
    const targetPath = getFlashbulbTrailmakersPath();
    const backupPath = getAppDataBackupPath();

    if (fs.existsSync(backupPath) && fs.readdirSync(backupPath).length > 0) {
        try {
            fs.mkdirSync(targetPath, { recursive: true });
            fs.readdirSync(targetPath).forEach(item => {
                const itemPath = path.join(targetPath, item);
                if (item !== '_backup') fs.rmSync(itemPath, { recursive: true, force: true });
            });
            fs.readdirSync(backupPath).forEach(item => {
                const itemPath = path.join(backupPath, item);
                const targetItemPath = path.join(targetPath, item);
                fs.renameSync(itemPath, targetItemPath);
            });
            if (fs.readdirSync(backupPath).length === 0) fs.rmSync(backupPath, { recursive: true, force: true });
            return true;
        } catch (error) {
            dialog.showErrorBox('Restore Error', `Could not restore Trailmakers profile data.\nError: ${error.message}`);
            return false;
        }
    }
    return true;
};

const renameTransformationSlotsFolder = async (originalName, newName) => {
    if (!isWindows) return true; 
    const documentsPath = app.getPath('documents');
    const trailmakersDocsPath = path.join(documentsPath, 'Trailmakers');
    const oldPath = path.join(trailmakersDocsPath, originalName);
    const newPath = path.join(trailmakersDocsPath, newName);

    if (fs.existsSync(oldPath)) {
        try {
            if (fs.existsSync(newPath)) fs.rmSync(newPath, { recursive: true, force: true });
            fs.renameSync(oldPath, newPath);
            return true;
        } catch (error) {
            dialog.showErrorBox('Folder Rename Error', `Could not rename folder.\nError: ${error.message}`);
            return false;
        }
    }
    return false;
};

ipcMain.on('launch-game', async (event, { downloadPath, versionName }) => {
    const folderName = getSafeFolderName(versionName);
    const versionPath = path.join(downloadPath, folderName);

    if (!fs.existsSync(versionPath)) {
        return dialog.showErrorBox('Launch Error', `Could not find game directory:\n${versionPath}`);
    }

    try {
        const steamSettingsPath = path.join(versionPath, 'steam_settings');
        const dlcFilePath = path.join(steamSettingsPath, 'DLC.txt');
        fs.mkdirSync(steamSettingsPath, { recursive: true });
        fs.writeFileSync(dlcFilePath, '');
    } catch (error) {
        return dialog.showErrorBox('Launch Error', `Could not prepare the DLC configuration file.\nError: ${error.message}`);
    }
    
    backupFlashbulbTrailmakers();
    await renameTransformationSlotsFolder('Transformation slots', '_Transformation slots');

    if (isWindows) {
        const exePath = path.join(versionPath, 'Trailmakers.exe');
        if (fs.existsSync(exePath)) {
            shell.openPath(exePath).catch(err => dialog.showErrorBox('Launch Error', `Could not start Trailmakers.exe.\nError: ${err.message}`));
        } else {
            dialog.showErrorBox('Launch Error', `Could not find Trailmakers.exe:\n${exePath}`);
        }
    } else {
        shell.openPath(versionPath).catch(err => dialog.showErrorBox('Launch Error', `Could not open folder:\n${err.message}`));
    }
});

ipcMain.handle('uninstall-version', async (event, { downloadPath, versionName }) => {
    const folderName = getSafeFolderName(versionName);
    const fullPath = path.join(downloadPath, folderName);
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Uninstall'], defaultId: 0,
        title: 'Confirm Uninstall', message: `Are you sure you want to permanently delete ${versionName}?`,
        detail: `This will delete the folder and all its contents at:\n${fullPath}`
    });
    if (result.response === 1) {
        try {
            restoreFlashbulbTrailmakers();
            await renameTransformationSlotsFolder('_Transformation slots', 'Transformation slots');
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
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

ipcMain.handle('check-and-download-steamcmd', async () => {
    const depotDownloaderExePath = path.join(resourcesPath, depotDownloaderExecutable);
    const crackedApiLibPath = path.join(resourcesPath, steamApiLib);

    if (!fs.existsSync(depotDownloaderExePath)) {
        dialog.showErrorBox('Missing Component', `${depotDownloaderExecutable} was not found.\nExpected at: ${depotDownloaderExePath}`);
        return false;
    }
    if (!fs.existsSync(crackedApiLibPath)) {
        dialog.showErrorBox('Missing Component', `${steamApiLib} was not found.\nExpected at: ${crackedApiLibPath}`);
        return false;
    }

    return true;
});

ipcMain.on('start-download', async (event, { username, password, version, downloadPath }) => {
    if (downloadProcess) {
        return event.reply('status-update', 'A download is already in progress.');
    }
    store.set('username', username);
    await keytar.setPassword(KEYTAR_SERVICE, username, password);
    const sendStatus = (message) => event.reply('status-update', message);
    const depotDownloaderExePath = path.join(resourcesPath, depotDownloaderExecutable);
    if (!fs.existsSync(depotDownloaderExePath)) {
        sendStatus(`Error: ${depotDownloaderExecutable} not found!`);
        return event.reply('download-complete', { success: false });
    }
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
        if (DEBUG_MODE) event.reply('debug-log-update', output);
        if (output.includes('Enter 2FA code:') || output.includes('STEAM GUARD! Use the Steam Mobile App')) {
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
        if (code === 0) {
            try {
                const downloadedContentPath = tempDownloadDir;
                const finalVersionPath = path.join(downloadPath, getSafeFolderName(version.name));
                if (!fs.existsSync(path.join(downloadedContentPath, 'Trailmakers.exe'))) {
                     throw new Error(`Download finished, but Trailmakers.exe was not found.`);
                }
                fs.renameSync(downloadedContentPath, finalVersionPath);
                const crackedApiLibPath = path.join(resourcesPath, steamApiLib);
                if (fs.existsSync(crackedApiLibPath)) {
                    sendStatus('Applying patch...');
                    const originalLibName = isWindows ? 'steam_api64.dll' : 'libsteam_api.so';
                    const results = findFileRecursive(finalVersionPath, originalLibName);
                    if (results && results.length > 0) {
                        fs.copyFileSync(crackedApiLibPath, results[0]);
                    } else {
                        fs.copyFileSync(crackedApiLibPath, path.join(finalVersionPath, steamApiLib));
                    }
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
    });
});

ipcMain.on('submit-steam-guard', (event, code) => {
    if (downloadProcess) {
        downloadProcess.stdin.write(`${code}\n`);
    }
});