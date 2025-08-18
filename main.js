const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn, exec } = require('child_process');
const Store = require('electron-store');
const keytar = require('keytar');
const DiscordRPC = require('discord-rpc');
const store = new Store();

const DEBUG_MODE = false;

const isPackaged = app.isPackaged;
const isWindows = process.platform === 'win32';
const resourcesPath = isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname;

const depotDownloaderExecutable = isWindows ? 'DepotDownloader.exe' : 'DepotDownloader';

const KEYTAR_SERVICE = 'trailmakers-downloader';
let mainWindow;
let downloadProcess;
let activeGameProcess = null;
let activeGameVersionName = null;
let gameStartTime;
let isSteamDirectoryModified = false; // Flag to track file state

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
const STEAM_APP_ID = '585420';

// versions that need the modified Steam API
const trailmakersVersions = [
    { name: "1.9.5 PvP Update: Part 1", manifestId: "3088992314067472200", requiresModifiedSteam: false },
    { name: "1.9 Pedal to the Metal", manifestId: "4412562610966151777", requiresModifiedSteam: false },
    { name: "1.8 Waves, Camera, Action", manifestId: "4007835113837207542", requiresModifiedSteam: false },
    { name: "1.7.4 Now This is Podracing", manifestId: "7499996565839882351", requiresModifiedSteam: false },
    { name: "1.7 Spacebound", manifestId: "4376696831141480241", requiresModifiedSteam: false },
    { name: "1.6 Wings and Weapons", manifestId: "7868502592313023064", requiresModifiedSteam: false },
    { name: "1.5 Decals", manifestId: "6418274266282092041", requiresModifiedSteam: false },
    { name: "1.4.2 Mirror Mode", manifestId: "8084832536635904913", requiresModifiedSteam: false },
    { name: "1.3 Mod Makers", manifestId: "752294084919392246", requiresModifiedSteam: false },
    { name: "1.2 Perfect Pitch", manifestId: "7125249926418413647", requiresModifiedSteam: false },
    { name: "1.1 Summer Party", manifestId: "7622037960763500709", requiresModifiedSteam: false },
    { name: "1.0.4 Centrifuge", manifestId: "7797596154752996883", requiresModifiedSteam: false },
    { name: "1.0 Release", manifestId: "2589706790386909403", requiresModifiedSteam: false },
    { name: "0.8.1 Tailwind", manifestId: "2174733110758165403", requiresModifiedSteam: false },
    { name: "0.8.0 Rally", manifestId: "6322044058692429718", requiresModifiedSteam: false },
    { name: "0.7.3 Happy Holidays", manifestId: "1401415892018513847", requiresModifiedSteam: false },
    { name: "0.7.2 The Danger Zone", manifestId: "6509328320731640329", requiresModifiedSteam: false },
    { name: "0.7.0 BLOCKS! BLOCKS! BLOCKS!", manifestId: "292833379719092558", requiresModifiedSteam: false },
    { name: "0.6.1 Logic Update", manifestId: "5774605827881735611", requiresModifiedSteam: false },
    { name: "0.6 Summer Update", manifestId: "8321905748150428964", requiresModifiedSteam: false },
    { name: "0.5.2 Submarine (Water Update #2)", manifestId: "4254061677353968400", requiresModifiedSteam: false },
    { name: "0.5.1 Build A Boat (Water Update #1)", manifestId: "5339152136185287284", requiresModifiedSteam: false },
    { name: "0.5 The Quality Update", manifestId: "9110008508980233200", requiresModifiedSteam: false },
    { name: "0.4.2 Race Island", manifestId: "4955326297487392530", requiresModifiedSteam: false },
    { name: "0.4.1 Rings of Fire", manifestId: "2127974181683886289", requiresModifiedSteam: false },
    { name: "0.4.0 Early Access", manifestId: "4365140693703019383", requiresModifiedSteam: false },
    { name: "Alpha Demo", manifestId: "1105845463103535907", requiresModifiedSteam: false },
];

// Helper function to get version info by name
const getVersionInfo = (versionName) => {
    return trailmakersVersions.find(v => v.name === versionName);
};

// --- ASYNCHRONOUS HELPER FUNCTIONS ---
const getSafeFolderName = (versionName) => `Trailmakers ${versionName.replace(/['":]/g, '')}`;

const clearDir = async (dirPath, exceptions = []) => {
    if (!fs.existsSync(dirPath)) return;
    try {
        const files = await fsp.readdir(dirPath);
        for (const file of files) {
            if (exceptions.includes(file)) continue;
            const fullPath = path.join(dirPath, file);
            try {
                const stat = await fsp.lstat(fullPath);
                if (stat.isDirectory()) {
                    await fsp.rm(fullPath, { recursive: true, force: true });
                } else {
                    await fsp.unlink(fullPath);
                }
            } catch (fileError) {
                if (fileError.code === 'EPERM' || fileError.code === 'EBUSY') {
                    console.warn(`Skipping locked file/directory: ${fullPath}`);
                } else {
                    throw fileError;
                }
            }
        }
    } catch (error) {
        console.error(`Failed to clear directory ${dirPath}:`, error);
        // Don't re-throw, allow operation to continue if possible
    }
};

const copyDirRecursive = async (src, dest) => {
    if (!fs.existsSync(src)) return;
    try {
        await fsp.mkdir(dest, { recursive: true });
        const entries = await fsp.readdir(src, { withFileTypes: true });
        for (let entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            try {
                if (entry.isDirectory()) {
                    await copyDirRecursive(srcPath, destPath);
                } else {
                    await fsp.copyFile(srcPath, destPath);
                }
            } catch (entryError) {
                if (entryError.code === 'EPERM' || entryError.code === 'EBUSY') {
                    console.warn(`Skipping locked file during copy: ${srcPath}`);
                } else {
                    console.error(`Error copying ${srcPath}:`, entryError);
                }
            }
        }
    } catch (error) {
        console.error(`Failed to copy directory from ${src} to ${dest}:`, error);
    }
};

const mergeDirRecursive = async (src, dest) => {
    if (!fs.existsSync(src)) return;
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        try {
            if (entry.isDirectory()) {
                await mergeDirRecursive(srcPath, destPath);
            } else {
                if (!fs.existsSync(destPath)) {
                    await fsp.copyFile(srcPath, destPath);
                }
            }
        } catch (error) {
            if (error.code === 'EPERM' || error.code === 'EBUSY') {
                console.warn(`Skipping problematic file in merge: ${srcPath}`);
            } else {
                console.error(`Error merging ${srcPath}:`, error);
            }
        }
    }
};

function findFileRecursive(startPath, filter) {
    let results = [];
    if (!fs.existsSync(startPath)) {
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

// --- STEAM DIRECTORY DETECTION ---
const findSteamTrailmakersPath = () => {
    if (!isWindows) return null;
    
    // Helper to check for executable
    const findTrailmakersExecutable = (directory) => {
        if (!fs.existsSync(directory)) return null;
        const exePath = path.join(directory, 'Trailmakers.exe');
        return fs.existsSync(exePath) ? directory : null;
    };
    
    // Find Steam path from registry
    const findSteamPath = () => {
        try {
            const { execSync } = require('child_process');
            const regQueries = [
                'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath',
                'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Valve\\Steam" /v InstallPath'
            ];
            for (const query of regQueries) {
                try {
                    const output = execSync(query, { encoding: 'utf8', stdio: 'pipe' });
                    const pathMatch = output.match(/InstallPath\s+REG_SZ\s+(.+?)(?:\r|\n|$)/i);
                    if (pathMatch && fs.existsSync(pathMatch[1].trim())) {
                        return pathMatch[1].trim();
                    }
                } catch (regError) { /* ignore */ }
            }
        } catch (error) { /* ignore */ }
        return null;
    };
    
    const steamPaths = [];
    const registrySteamPath = findSteamPath();
    if (registrySteamPath) steamPaths.push(registrySteamPath);
    
    // Add common fallback paths
    steamPaths.push(
        path.join('C:', 'Program Files (x86)', 'Steam'),
        path.join('C:', 'Program Files', 'Steam')
    );
    
    const uniqueSteamPaths = [...new Set(steamPaths)];
    
    for (const steamPath of uniqueSteamPaths) {
        if (!fs.existsSync(steamPath)) continue;
        
        // Check default library first
        let foundPath = findTrailmakersExecutable(path.join(steamPath, 'steamapps', 'common', 'Trailmakers'));
        if (foundPath) return foundPath;
        
        // Check other libraries via libraryfolders.vdf
        const libraryFoldersPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
        if (fs.existsSync(libraryFoldersPath)) {
            const libraryContent = fs.readFileSync(libraryFoldersPath, 'utf8');
            const pathRegex = /"path"\s+"([^"]+)"/g;
            let match;
            while ((match = pathRegex.exec(libraryContent)) !== null) {
                const libraryPath = match[1].replace(/\\\\/g, '\\');
                const manifestPath = path.join(libraryPath, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`);
                if (fs.existsSync(manifestPath)) {
                    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                    const installDirMatch = manifestContent.match(/"installdir"\s+"([^"]+)"/);
                    if (installDirMatch) {
                        foundPath = findTrailmakersExecutable(path.join(libraryPath, 'steamapps', 'common', installDirMatch[1]));
                        if (foundPath) return foundPath;
                    }
                }
            }
        }
    }
    return null;
};

const findSteamExecutable = () => {
    if (!isWindows) return null;
    const steamPaths = [
        path.join('C:', 'Program Files (x86)', 'Steam', 'steam.exe'),
        path.join('C:', 'Program Files', 'Steam', 'steam.exe'),
    ];
    for (const steamPath of steamPaths) {
        if (fs.existsSync(steamPath)) return steamPath;
    }
    return null;
};

// --- STEAM DIRECTORY MANAGEMENT ---
let STEAM_TRAILMAKERS_PATH = null;
let OLD_TRAILS_VERSIONS_PATH = null;
let STEAM_BACKUP_PATH = null;

const initializePaths = () => {
    STEAM_TRAILMAKERS_PATH = findSteamTrailmakersPath();
    if (STEAM_TRAILMAKERS_PATH) {
        console.log(`Successfully found Steam Trailmakers at: ${STEAM_TRAILMAKERS_PATH}`);
        OLD_TRAILS_VERSIONS_PATH = path.join(STEAM_TRAILMAKERS_PATH, 'OldTrails');
        STEAM_BACKUP_PATH = path.join(OLD_TRAILS_VERSIONS_PATH, '_SteamBackup');
        
        if (!fs.existsSync(OLD_TRAILS_VERSIONS_PATH)) {
            fs.mkdirSync(OLD_TRAILS_VERSIONS_PATH, { recursive: true });
        }
        
        store.set('steamTrailmakersPath', STEAM_TRAILMAKERS_PATH);
        store.set('oldTrailsVersionsPath', OLD_TRAILS_VERSIONS_PATH);
    } else {
        console.error('Could not find Steam Trailmakers installation');
    }
};

const backupSteamDirectory = async () => {
   if (!isWindows || !STEAM_TRAILMAKERS_PATH) return;
   
   try {
       await fsp.mkdir(STEAM_BACKUP_PATH, { recursive: true });
       const steamGameBackupPath = path.join(STEAM_BACKUP_PATH, 'SteamGame');
       
       if (!fs.existsSync(steamGameBackupPath)) {
           console.log('Backing up original Steam game directory...');
           await fsp.mkdir(steamGameBackupPath, { recursive: true });
           const items = await fsp.readdir(STEAM_TRAILMAKERS_PATH);
           for (const item of items) {
               if (item === 'OldTrails') continue;
               const srcPath = path.join(STEAM_TRAILMAKERS_PATH, item);
               const destPath = path.join(steamGameBackupPath, item);
               try {
                   const stat = await fsp.lstat(srcPath);
                   if (stat.isDirectory()) {
                       await copyDirRecursive(srcPath, destPath);
                   } else {
                       await fsp.copyFile(srcPath, destPath);
                   }
               } catch (error) {
                   console.warn(`Could not back up ${srcPath}:`, error.message);
               }
           }
           console.log('Steam game backup complete');
       }
   } catch (error) {
       console.error('Failed to backup Steam directory:', error);
   }
};

const restoreSteamDirectory = async () => {
  if (!isWindows || !STEAM_TRAILMAKERS_PATH) return;
  const steamGameBackupPath = path.join(STEAM_BACKUP_PATH, 'SteamGame');
  if (!fs.existsSync(steamGameBackupPath)) return;
  
  try {
      console.log('Restoring original Steam game directory...');
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for file handles to release
      await clearDir(STEAM_TRAILMAKERS_PATH, ['OldTrails', 'mods']);
      await copyDirRecursive(steamGameBackupPath, STEAM_TRAILMAKERS_PATH);
      console.log('Steam game directory restored successfully');
      isSteamDirectoryModified = false; // Reset the flag to false here
  } catch (error) {
      console.error('Failed to restore Steam directory:', error.message);
  }
};

const installVersionToSteamDirectory = async (versionName) => {
  if (!isWindows || !STEAM_TRAILMAKERS_PATH || !OLD_TRAILS_VERSIONS_PATH) return false;
  const versionPath = path.join(OLD_TRAILS_VERSIONS_PATH, getSafeFolderName(versionName));
  if (!fs.existsSync(versionPath)) return false;
  
  try {
      console.log(`Installing ${versionName} to Steam directory...`);
      await clearDir(STEAM_TRAILMAKERS_PATH, ['OldTrails', 'mods']);
      await copyDirRecursive(versionPath, STEAM_TRAILMAKERS_PATH);
      console.log(`${versionName} installed successfully`);
      isSteamDirectoryModified = true; // Set the flag to true here
      return true;
  } catch (error) {
      console.error('Failed to install version to Steam directory:', error);
      return false;
  }
};

const launchGameThroughSteam = () => {
  return new Promise((resolve, reject) => {
      const steamExe = findSteamExecutable();
      if (!steamExe) return reject(new Error('Steam executable not found'));
      
      const steamCommand = `"${steamExe}" -applaunch ${STEAM_APP_ID}`;
      exec(steamCommand, (error) => {
          if (error) {
              console.error('Steam launch error:', error);
              return reject(error);
          }
          resolve();
      });
  });
};

// --- STEAM FILES SETUP FUNCTIONS ---
const setupSteamFiles = (gameDirectory, versionName) => {
  const versionInfo = getVersionInfo(versionName);
  if (!versionInfo || !versionInfo.requiresModifiedSteam) return;

  try {
      const steamAppIdSourcePath = path.join(__dirname, 'steam_appid.txt');
      const steamInterfacesSourcePath = path.join(__dirname, 'steam_interfaces.txt');
      const steamAppIdDestPath = path.join(gameDirectory, 'steam_appid.txt');
      const steamInterfacesDestPath = path.join(gameDirectory, 'steam_interfaces.txt');
      const steamSettingsDir = path.join(gameDirectory, 'steam_settings');
      
      if (fs.existsSync(steamAppIdSourcePath)) fs.copyFileSync(steamAppIdSourcePath, steamAppIdDestPath);
      if (fs.existsSync(steamInterfacesSourcePath)) fs.copyFileSync(steamInterfacesSourcePath, steamInterfacesDestPath);
      if (!fs.existsSync(steamSettingsDir)) fs.mkdirSync(steamSettingsDir, { recursive: true });
      fs.writeFileSync(path.join(steamSettingsDir, 'dlc.txt'), '', 'utf8');

  } catch (error) {
      console.error('Error setting up Steam files:', error);
  }
};

const verifySteamFiles = (gameDirectory, versionName) => {
  const versionInfo = getVersionInfo(versionName);
  if (!versionInfo || !versionInfo.requiresModifiedSteam) return;

  try {
      const steamSettingsDir = path.join(gameDirectory, 'steam_settings');
      if (!fs.existsSync(steamSettingsDir)) fs.mkdirSync(steamSettingsDir, { recursive: true });
      
      const dlcTxtPath = path.join(steamSettingsDir, 'dlc.txt');
      if (!fs.existsSync(dlcTxtPath) || fs.readFileSync(dlcTxtPath, 'utf8').trim() !== '') {
          fs.writeFileSync(dlcTxtPath, '', 'utf8');
      }
      
      const steamAppIdPath = path.join(gameDirectory, 'steam_appid.txt');
      if (!fs.existsSync(steamAppIdPath)) {
          const sourcePath = path.join(__dirname, 'steam_appid.txt');
          if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, steamAppIdPath);
      }

      const steamInterfacesPath = path.join(gameDirectory, 'steam_interfaces.txt');
      if (!fs.existsSync(steamInterfacesPath)) {
          const sourcePath = path.join(__dirname, 'steam_interfaces.txt');
          if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, steamInterfacesPath);
      }
  } catch (error) {
      console.error('Error verifying Steam files:', error);
  }
};

// --- GAME PROCESS MONITORING ---
const monitorGameProcess = (versionName) => {
  let consecutiveNotFound = 0;
  const checkProcess = () => {
      exec('tasklist /fi "imagename eq Trailmakers.exe" /fo csv', (error, stdout) => {
          if (error || !stdout.includes('Trailmakers.exe')) {
              consecutiveNotFound++;
              if (consecutiveNotFound >= 3 && activeGameProcess) {
                  console.log(`Trailmakers process for ${versionName} has closed.`);
                  mainWindow.webContents.send('status-update', 'Game closed, saving session...');
                  
                  setTimeout(async () => {
                      await saveVersionSession(versionName);
                      mainWindow.webContents.send('status-update', 'Restoring files...');
                      await restoreSteamDirectory();
                      await restoreMainSave();
                      
                      gameStartTime = null;
                      setActivity('Browsing old versions', 'In the launcher');
                      mainWindow.webContents.send('status-update', `${versionName} session saved. Files restored.`);
                      activeGameProcess = null;
                      activeGameVersionName = null;
                      mainWindow.webContents.send('game-closed');
                      setTimeout(() => mainWindow.webContents.send('status-update', 'Ready.'), 3000);
                  }, 2000); // Wait for files to be fully released
                  return;
              }
          } else {
              consecutiveNotFound = 0;
          }
          if (activeGameProcess) {
              setTimeout(checkProcess, 2000);
          }
      });
  };
  setTimeout(checkProcess, 3000);
};

// --- SAVE MANAGEMENT LOGIC ---
const LOCAL_LOW_PATH = path.join(app.getPath('appData'), '..', 'LocalLow', 'Flashbulb', 'Trailmakers');
const DOCUMENTS_PATH = path.join(app.getPath('documents'), 'TrailMakers');
const OLD_TRAILS_ROOT_PATH = path.join(app.getPath('documents'), 'OldTrails');
const MAIN_BACKUP_PATH = path.join(OLD_TRAILS_ROOT_PATH, '_MainBackup');

const backupMainSave = async () => {
  if (!isWindows) return;
  console.log('Backing up main Trailmakers save data...');
  try {
      if (fs.existsSync(MAIN_BACKUP_PATH)) {
          await fsp.rm(MAIN_BACKUP_PATH, { recursive: true, force: true });
      }
      await fsp.mkdir(path.join(MAIN_BACKUP_PATH, 'LocalLow'), { recursive: true });
      await fsp.mkdir(path.join(MAIN_BACKUP_PATH, 'Documents'), { recursive: true });

      if (fs.existsSync(LOCAL_LOW_PATH)) await copyDirRecursive(LOCAL_LOW_PATH, path.join(MAIN_BACKUP_PATH, 'LocalLow'));
      if (fs.existsSync(DOCUMENTS_PATH)) await copyDirRecursive(DOCUMENTS_PATH, path.join(MAIN_BACKUP_PATH, 'Documents'));
      console.log('Main save backup complete.');
  } catch (error) {
      console.error('Failed to create main save backup:', error);
  }
};

const restoreMainSave = async () => {
  if (!isWindows || !fs.existsSync(MAIN_BACKUP_PATH)) return;
  console.log('Restoring main Trailmakers save data...');
  try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await clearDir(LOCAL_LOW_PATH);
      await clearDir(DOCUMENTS_PATH, ['OldTrails']);
      await copyDirRecursive(path.join(MAIN_BACKUP_PATH, 'LocalLow'), LOCAL_LOW_PATH);
      await copyDirRecursive(path.join(MAIN_BACKUP_PATH, 'Documents'), DOCUMENTS_PATH);
      console.log('Main save restoration complete.');
  } catch (error) {
      console.error('Failed to restore main save backup:', error);
  }
};

const prepareVersionSave = async (versionName) => {
  if (!isWindows || !OLD_TRAILS_VERSIONS_PATH) return;
  
  const versionSavePath = path.join(OLD_TRAILS_VERSIONS_PATH, getSafeFolderName(versionName), '_SaveData');
  const masterBackupBlueprintsPath = path.join(MAIN_BACKUP_PATH, 'Documents', 'Blueprints');
  const liveBlueprintsPath = path.join(DOCUMENTS_PATH, 'Blueprints');

  await clearDir(LOCAL_LOW_PATH);
  await clearDir(DOCUMENTS_PATH, ['OldTrails', 'Blueprints']);
  await mergeDirRecursive(masterBackupBlueprintsPath, liveBlueprintsPath);

  if (fs.existsSync(versionSavePath)) {
      console.log(`Restoring save data for ${versionName}.`);
      await copyDirRecursive(path.join(versionSavePath, 'LocalLow'), LOCAL_LOW_PATH);
      
      const versionSaveDocs = path.join(versionSavePath, 'Documents');
      if (fs.existsSync(versionSaveDocs)) {
          const entries = await fsp.readdir(versionSaveDocs, { withFileTypes: true });
          for (const entry of entries) {
              if (entry.name === 'Blueprints') continue;
              const src = path.join(versionSaveDocs, entry.name);
              const dest = path.join(DOCUMENTS_PATH, entry.name);
              if (entry.isDirectory()) {
                  await copyDirRecursive(src, dest);
              } else {
                  await fsp.copyFile(src, dest);
              }
          }
      }
      
      const versionBlueprintsPath = path.join(versionSaveDocs, 'Blueprints');
      if (fs.existsSync(versionBlueprintsPath)) {
          await mergeDirRecursive(versionBlueprintsPath, liveBlueprintsPath);
      }
  }
};

const saveVersionSession = async (versionName) => {
  if (!isWindows || !OLD_TRAILS_VERSIONS_PATH) return;

  const versionSavePath = path.join(OLD_TRAILS_VERSIONS_PATH, getSafeFolderName(versionName), '_SaveData');
  const liveBlueprintsPath = path.join(DOCUMENTS_PATH, 'Blueprints');
  const masterBackupBlueprintsPath = path.join(MAIN_BACKUP_PATH, 'Documents', 'Blueprints');
  
  console.log(`Saving session data for: ${versionName}`);
  try {
      if (fs.existsSync(versionSavePath)) {
         await fsp.rm(versionSavePath, { recursive: true, force: true });
      }
      await fsp.mkdir(path.join(versionSavePath, 'LocalLow'), { recursive: true });
      const versionSaveDocs = path.join(versionSavePath, 'Documents');
      await fsp.mkdir(versionSaveDocs, { recursive: true });

      await copyDirRecursive(LOCAL_LOW_PATH, path.join(versionSavePath, 'LocalLow'));
      
      const docEntries = await fsp.readdir(DOCUMENTS_PATH, { withFileTypes: true });
      for(const entry of docEntries) {
          if(entry.name === 'Blueprints' || entry.name === 'OldTrails') continue;
          const src = path.join(DOCUMENTS_PATH, entry.name);
          const dest = path.join(versionSaveDocs, entry.name);
          if(entry.isDirectory()) {
              await copyDirRecursive(src, dest);
          } else {
              await fsp.copyFile(src, dest);
          }
      }

      if (fs.existsSync(liveBlueprintsPath)) {
          await mergeDirRecursive(liveBlueprintsPath, masterBackupBlueprintsPath);
      }
      await copyDirRecursive(masterBackupBlueprintsPath, path.join(versionSaveDocs, 'Blueprints'));
      console.log(`Session for ${versionName} saved successfully.`);
  } catch (error) {
      console.error(`Failed to save session for ${versionName}:`, error);
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
    // Defer heavy work until the window is ready to show status updates
    mainWindow.webContents.once('did-finish-load', async () => {
        mainWindow.webContents.send('status-update', 'Initializing...');
        initializePaths();

        if (isWindows && STEAM_TRAILMAKERS_PATH) {
            mainWindow.webContents.send('status-update', 'Backing up main save files...');
            await backupMainSave();
            mainWindow.webContents.send('status-update', 'Backing up Steam game files...');
            await backupSteamDirectory();
        }
        
        mainWindow.webContents.send('initialization-complete');
        mainWindow.webContents.send('status-update', 'Ready. Select a version to install.');
    });
});

app.on('window-all-closed', () => {
  if (downloadProcess) downloadProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  rpc.destroy().catch(console.error);
});

// --- IPC HANDLERS ---
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('maximize-window', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('close-window', async () => {
  if (activeGameProcess) {
      dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Game Still Running',
          message: 'A version of Trailmakers is still running. Please close it first.',
          buttons: ['OK']
      });
      return;
  }

  // Only restore if the directory has been modified
  if (isSteamDirectoryModified) {
    mainWindow.webContents.send('status-update', 'Restoring files, please wait...');
    await restoreMainSave();
    await restoreSteamDirectory();
  }
  
  mainWindow.close();
});

ipcMain.handle('get-credentials', async () => {
  const username = store.get('username', '');
  let password = null;
  if (username) password = await keytar.getPassword(KEYTAR_SERVICE, username);
  return { username, password, downloadPath: OLD_TRAILS_VERSIONS_PATH || 'Steam not found' };
});

ipcMain.on('ui-ready', (event) => {
  event.reply('versions-loaded', trailmakersVersions);
  if (STEAM_TRAILMAKERS_PATH) {
      event.reply('steam-found', { path: STEAM_TRAILMAKERS_PATH, versionsPath: OLD_TRAILS_VERSIONS_PATH });
  } else {
      event.reply('steam-not-found');
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-installed-versions', () => {
  if (!OLD_TRAILS_VERSIONS_PATH || !fs.existsSync(OLD_TRAILS_VERSIONS_PATH)) return [];
  try {
      const directories = fs.readdirSync(OLD_TRAILS_VERSIONS_PATH, { withFileTypes: true });
      return trailmakersVersions
          .filter(v => directories.some(dir => dir.isDirectory() && dir.name === getSafeFolderName(v.name)))
          .map(v => v.manifestId);
  } catch (error) {
      console.error("Failed to scan for installed versions:", error);
      return [];
  }
});

ipcMain.on('launch-game', async (event, { versionName }) => {
  if (!STEAM_TRAILMAKERS_PATH) {
      return dialog.showErrorBox('Launch Error', 'Steam Trailmakers installation not found.');
  }

  try {
      event.reply('status-update', `Installing ${versionName}...`);
      const installSuccess = await installVersionToSteamDirectory(versionName);
      if (!installSuccess) throw new Error(`Failed to install ${versionName} to Steam directory.`);

      const versionInfo = getVersionInfo(versionName);
      if (versionInfo?.requiresModifiedSteam) {
          verifySteamFiles(STEAM_TRAILMAKERS_PATH, versionName);
      }
      
      event.reply('status-update', `Preparing save for ${versionName}...`);
      await prepareVersionSave(versionName);

      event.reply('status-update', 'Launching through Steam...');
      await launchGameThroughSteam();
      
      activeGameProcess = true;
      activeGameVersionName = versionName;
      gameStartTime = new Date();
      setActivity('Playing Trailmakers', `Version: ${versionName}`);
      
      event.reply('status-update', `Playing ${versionName}...`);
      event.reply('game-launched', versionName);
      
      monitorGameProcess(versionName);

  } catch(err) {
      console.error('Launch error:', err);
      dialog.showErrorBox('Launch Error', `Could not start Trailmakers.\nError: ${err.message}`);
      event.reply('status-update', 'Restoring files after launch error...');
      await restoreSteamDirectory();
      activeGameProcess = null;
      activeGameVersionName = null;
      gameStartTime = null;
      setActivity('Browsing old versions', 'In the launcher');
      event.reply('game-closed');
      setTimeout(() => event.reply('status-update', 'Ready.'), 3000);
  }
});

ipcMain.handle('uninstall-version', async (event, { versionName }) => {
  if (activeGameVersionName === versionName) {
      return { success: false, message: 'Cannot uninstall a running version.' };
  }
  if (!OLD_TRAILS_VERSIONS_PATH) {
      return { success: false, message: 'Steam Trailmakers not found.' };
  }

  const fullPath = path.join(OLD_TRAILS_VERSIONS_PATH, getSafeFolderName(versionName));
  const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Cancel', 'Uninstall'], defaultId: 0, cancelId: 0,
      title: 'Confirm Uninstall', message: `Are you sure you want to delete ${versionName}?`,
      detail: `This will permanently delete:\n${fullPath}`
  });
  if (result.response === 1) {
      try {
          if (fs.existsSync(fullPath)) {
              await fsp.rm(fullPath, { recursive: true, force: true });
              return { success: true, message: `${versionName} uninstalled.` };
          }
          return { success: false, message: 'Folder not found.' };
      } catch (error) {
          return { success: false, message: `Error: ${error.message}` };
      }
  }
  return { success: false, message: 'Uninstall cancelled.' };
});

ipcMain.handle('factory-reset', async () => {
    if (activeGameProcess) {
        return { success: false, message: 'Cannot reset while a game is running.' };
    }
    if (!OLD_TRAILS_VERSIONS_PATH) {
        return { success: false, message: 'Steam Trailmakers not found.' };
    }

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Yes, Delete Everything'], defaultId: 0,
        title: 'Confirm Factory Reset', message: 'Are you absolutely sure?',
        detail: 'This will delete all downloaded versions and their saves. Your main game will be restored from backup. This cannot be undone.'
    });

    if (result.response === 1) {
        try {
            console.log(`Performing factory reset on: ${OLD_TRAILS_VERSIONS_PATH}`);
            const items = await fsp.readdir(OLD_TRAILS_VERSIONS_PATH);
            for (const item of items) {
                const itemPath = path.join(OLD_TRAILS_VERSIONS_PATH, item);
                if ((await fsp.lstat(itemPath)).isDirectory()) {
                    await fsp.rm(itemPath, { recursive: true, force: true });
                }
            }
            await restoreMainSave();
            await restoreSteamDirectory();
            return { success: true, message: 'Factory reset complete.' };
        } catch (error) {
            return { success: false, message: `Error: ${error.message}` };
        }
    }
    return { success: false, message: 'Factory reset cancelled.' };
});

ipcMain.on('start-download', async (event, { username, password, version }) => {
  if (downloadProcess) return event.reply('status-update', 'A download is already in progress.');
  if (!OLD_TRAILS_VERSIONS_PATH) return event.reply('status-update', 'Error: Steam Trailmakers not found.');
  
  setActivity('Downloading', version.name);
  store.set('username', username);
  await keytar.setPassword(KEYTAR_SERVICE, username, password);

  const sendStatus = (message) => event.reply('status-update', message);
  const depotDownloaderExePath = path.join(resourcesPath, depotDownloaderExecutable);
  const tempDownloadDir = path.join(OLD_TRAILS_VERSIONS_PATH, `_temp_${version.manifestId}`);
  
  try {
    if (fs.existsSync(tempDownloadDir)) await fsp.rm(tempDownloadDir, { recursive: true, force: true });
    await fsp.mkdir(tempDownloadDir, { recursive: true });
  } catch (dirError) {
      sendStatus(`Error preparing download directory: ${dirError.message}`);
      return;
  }

  const args = [
      '-app', TRAILMAKERS_APP_ID, '-depot', TRAILMAKERS_DEPOT_ID,
      '-manifest', version.manifestId, '-username', username,
      '-password', password, '-remember-password', '-dir', tempDownloadDir,
      '-validate', '-os', 'windows', '-osarch', '64', '-max-downloads', '26'
  ];

  downloadProcess = spawn(depotDownloaderExePath, args);
  let stderrOutput = ''; 
  const handleOutput = (data) => {
      const output = data.toString();
      if (output.includes('auth code sent to the email')) event.reply('steam-email-required');
      else if (output.includes('Enter 2FA code:')) event.reply('steam-guard-required');
      else if (output.includes('Use the Steam Mobile App')) event.reply('steam-mobile-required');
      else if (output.includes('Logging')) sendStatus('Logging in to Steam...');
      else if (output.includes('Processing depot')) sendStatus('Processing depot...');
      else if (output.includes('Downloading depot')) sendStatus('Starting download...');
      else if (output.includes('Depot download complete')) sendStatus('Finalizing files...');
      
      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (progressMatch) {
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
  downloadProcess.on('close', async (code) => {
      setActivity('Browsing old versions', 'In the launcher');
      if (code === 0) {
          try {
              const finalVersionPath = path.join(OLD_TRAILS_VERSIONS_PATH, getSafeFolderName(version.name));
              if (!fs.existsSync(path.join(tempDownloadDir, 'Trailmakers.exe'))) {
                   throw new Error(`Download finished, but Trailmakers.exe was not found.`);
              }
              
              await fsp.rename(tempDownloadDir, finalVersionPath);

              const versionInfo = getVersionInfo(version.name);
              if (versionInfo?.requiresModifiedSteam) {
                  sendStatus('Applying Steam modifications...');
                  const modifiedApiLibPath = path.join(resourcesPath, 'steam_api64.dll');
                  const originalLibPath = findFileRecursive(finalVersionPath, 'steam_api64.dll')[0] || path.join(finalVersionPath, 'steam_api64.dll');
                  await fsp.copyFile(modifiedApiLibPath, originalLibPath);
                  setupSteamFiles(finalVersionPath, version.name);
              }

              sendStatus('Installation Complete!');
              event.reply('download-complete', { success: true, installedManifestId: version.manifestId });
              mainWindow.webContents.send('refresh-installed-versions');
          } catch (finalizeError) {
              sendStatus(`Error finalizing installation: ${finalizeError.message}`);
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

rpc.on('ready', () => {
  console.log('Discord RPC is ready.');
  rpcReady = true;
  setActivity('Browsing old versions', 'In the launcher');
});

if (DISCORD_CLIENT_ID) {
  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(err => {
      console.error('Failed to connect to Discord RPC:', err);
  });
}