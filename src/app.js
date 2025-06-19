const { useState, useEffect, useRef } = React;

const TitleBar = ({ appVersion }) => (
    <div className="title-bar h-8 bg-gray-800 flex justify-between items-center px-3 flex-shrink-0">
        <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span className="text-gray-300 font-semibold text-sm">Old Trails</span>
            {appVersion && <span className="text-gray-500 text-xs ml-2">v{appVersion}</span>}
        </div>
        <div className="flex items-center space-x-2">
            <button onClick={() => window.electronAPI.minimizeWindow()} className="title-bar-button h-4 w-4 rounded-full bg-yellow-500 hover:bg-yellow-600"></button>
            <button onClick={() => window.electronAPI.maximizeWindow()} className="title-bar-button h-4 w-4 rounded-full bg-green-500 hover:bg-green-600"></button>
            <button onClick={() => window.electronAPI.closeWindow()} className="title-bar-button h-4 w-4 rounded-full bg-red-500 hover:bg-red-600"></button>
        </div>
    </div>
);

const VersionCard = ({ version, isInstalled, isDownloading, isProcessing, platform, onDownload, onPlay, onUninstall }) => {
    const match = version.name.match(/^([\d\.]+) (.*)/);
    const versionNumber = match ? match[1] : '';
    const updateName = match ? match[2] : version.name;
    const isWindows = platform === 'win32';

    return (
        <div className={`bg-gray-800 p-4 rounded-lg flex items-center justify-between transition-all duration-300 ${isDownloading ? 'ring-2 ring-cyan-500' : 'ring-1 ring-gray-700'}`}>
            <div>
                {versionNumber && <span className="font-bold text-lg text-cyan-400 mr-2">{versionNumber}</span>}
                <span className="font-semibold text-white">{updateName}</span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
                {isInstalled ? (
                    <>
                        <button onClick={onPlay} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-md text-sm transition-colors">
                            {isWindows ? 'Play' : 'Show in Folder'}
                        </button>
                        <button onClick={onUninstall} className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-md text-sm transition-colors">Uninstall</button>
                    </>
                ) : (
                    <button
                        onClick={onDownload}
                        disabled={isProcessing}
                        className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-md text-sm transition-colors"
                    >
                        {isDownloading ? 'Installing...' : 'Install'}
                    </button>
                )}
            </div>
        </div>
    );
};

const AuthPrompt = ({ onCodeSubmit }) => {
    const [steamGuardCode, setSteamGuardCode] = useState('');
    const handleSubmit = (e) => {
        e.preventDefault();
        if (!steamGuardCode) return;
        onCodeSubmit(steamGuardCode);
        setSteamGuardCode('');
    };
    return (
        <div className="p-4 bg-gray-700/50 rounded-lg space-y-3 border border-yellow-500/30">
            <div className="text-center">
                <p className="font-semibold text-yellow-300">Authentication Required</p>
                <p className="text-sm text-gray-300">Approve on your mobile app, or enter the code below.</p>
            </div>
            <form onSubmit={handleSubmit} className="flex gap-2 items-center">
                <input type="text" placeholder="Enter code here" value={steamGuardCode} onChange={(e) => setSteamGuardCode(e.target.value)} className="flex-grow min-w-0 bg-gray-800 border border-gray-600 rounded-md p-2 text-sm focus:ring-2 focus:ring-yellow-500 focus:outline-none" autoFocus />
                <button type="submit" className="flex-shrink-0 bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-3 rounded-md text-sm transition-colors">Submit</button>
            </form>
        </div>
    );
};

function App() {
    const [versions, setVersions] = useState([]);
    const [installedVersions, setInstalledVersions] = useState([]);
    const [appVersion, setAppVersion] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [downloadPath, setDownloadPath] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [currentDownload, setCurrentDownload] = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('Welcome! Please enter your details.');
    const [needsAuthCode, setNeedsAuthCode] = useState(false);
    const [platform, setPlatform] = useState('');

    const downloadPathRef = useRef(downloadPath);
    useEffect(() => {
        downloadPathRef.current = downloadPath;
    }, [downloadPath]);

    const fetchInstalledVersions = async () => {
        const currentPath = downloadPathRef.current;
        if (currentPath) {
            const installed = await window.electronAPI.getInstalledVersions(currentPath);
            setInstalledVersions(installed);
        }
    };

    useEffect(() => {
        const setup = async () => {
            const creds = await window.electronAPI.getCredentials();
            setUsername(creds.username || '');
            setPassword(creds.password || '');
            setDownloadPath(creds.downloadPath || '');
            const version = await window.electronAPI.getAppVersion();
            setAppVersion(version);
            setStatusMessage('Verifying downloader...');
            const downloaderReady = await window.electronAPI.checkAndDownloadSteamCmd();
            setStatusMessage(downloaderReady ? 'Ready. Select a version to install.' : 'Required files not found. Please check setup.');
            if (creds.downloadPath) {
                const installed = await window.electronAPI.getInstalledVersions(creds.downloadPath);
                setInstalledVersions(installed);
            }
        };

        setup();

        window.electronAPI.onVersionsLoaded(setVersions);
        window.electronAPI.onPlatformInfo(setPlatform);
        window.electronAPI.uiReady();

        const handleStatusUpdate = (message) => {
            setStatusMessage(message);
            if (!message.toLowerCase().includes('steam guard') && !message.toLowerCase().includes('approve login')) {
                setNeedsAuthCode(false);
            }
        };
        const handleDownloadComplete = ({ success }) => {
            if (success) {
                fetchInstalledVersions();
            }
            setIsProcessing(false);
            setCurrentDownload(null);
            setStatusMessage(success ? 'Installation Complete!' : 'Download failed or was cancelled.');
            setTimeout(() => setStatusMessage('Ready. Select a version to install.'), 5000);
        };
        
        const removeStatusListener = window.electronAPI.onStatusUpdate(handleStatusUpdate);
        const removeProgressListener = window.electronAPI.onDownloadProgress(({ progress }) => setDownloadProgress(progress));
        const removeGuardListener = window.electronAPI.onSteamGuardRequired(() => setNeedsAuthCode(true));
        const removeDownloadCompleteListener = window.electronAPI.onDownloadComplete(handleDownloadComplete);

        return () => {
            window.electronAPI.removeAllListeners('versions-loaded');
            window.electronAPI.removeAllListeners('platform-info');
            removeStatusListener();
            removeProgressListener();
            removeGuardListener();
            removeDownloadCompleteListener();
        };
    }, []);

    const handleSelectFolder = async () => {
        const path = await window.electronAPI.selectFolder();
        if (path) {
            setDownloadPath(path);
            const installed = await window.electronAPI.getInstalledVersions(path);
            setInstalledVersions(installed);
        }
    };

    const handleDownload = (version) => {
        if (!username || !password || !downloadPath) {
            setStatusMessage('Error: Username, password, and folder are required.');
            return;
        }
        setIsProcessing(true);
        setCurrentDownload(version.manifestId);
        setDownloadProgress(0);
        window.electronAPI.startDownload({ username, password, version, downloadPath });
    };

    const handlePlay = (version) => {
        setStatusMessage(`Launching ${version.name}...`);
        window.electronAPI.launchGame({ downloadPath, versionName: version.name });
    };

    const handleUninstall = async (version) => {
        setStatusMessage(`Uninstalling ${version.name}...`);
        const result = await window.electronAPI.uninstallVersion({ downloadPath, versionName: version.name });
        setStatusMessage(result.message);
        if (result.success) {
            fetchInstalledVersions();
        }
    };

    const handleCodeSubmit = (code) => {
        window.electronAPI.submitSteamGuard(code);
    };

    const filteredVersions = versions.filter(v => v.name.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="h-screen flex flex-col bg-gray-900 text-gray-200 select-none">
            <TitleBar appVersion={appVersion} />
            <div className="flex-grow flex p-4 gap-4 overflow-hidden">
                <div className="w-1/3 flex-shrink-0 flex flex-col gap-4 min-w-0">
                    <div className="bg-gray-800 p-4 rounded-lg border border-gray-700/50">
                        <h2 className="text-lg font-bold text-white border-b border-gray-700 pb-2 mb-3">Settings</h2>
                        <div className="space-y-3">
                            <input type="text" placeholder="Steam Username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={isProcessing} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:outline-none" />
                            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={isProcessing} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:outline-none" />
                            <button onClick={handleSelectFolder} disabled={isProcessing} className="w-full text-left bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-md p-2 text-sm transition-colors truncate">
                                <span className="font-semibold">Path:</span> {downloadPath || 'Choose Folder...'}
                            </button>
                        </div>
                    </div>
                    
                    {isProcessing && needsAuthCode && <AuthPrompt onCodeSubmit={handleCodeSubmit} />}
                    
                    <div className="flex-grow bg-gray-800 p-4 rounded-lg border border-gray-700/50 flex flex-col justify-center">
                        <h3 className="text-md font-bold text-white mb-2">Status</h3>
                        <p className="text-cyan-300 text-sm h-10">{statusMessage}</p>
                        {isProcessing && (
                             <div className="w-full bg-gray-700 rounded-full h-4 mt-2 shadow-inner overflow-hidden">
                                <div className="bg-cyan-500 h-4 rounded-full transition-all duration-500" style={{ width: `${downloadProgress}%` }}></div>
                            </div>
                        )}
                    </div>
                    
                    <div className="bg-blue-900/30 text-blue-200 p-3 rounded-lg text-xs text-center border border-blue-800/50 mt-auto">
                        <p>All game versions downloaded via this tool only support <strong>offline or LAN use only</strong>.</p>
                    </div>
                    <div className="bg-yellow-900/30 text-yellow-200 p-3 rounded-lg text-xs text-center border border-yellow-800/50">
                        <p>This app is a community tool and is not affiliated with Flashbulb Games.</p>
                    </div>

                </div>
                <div className="w-2/3 flex flex-col bg-gray-800 p-4 rounded-lg border border-gray-700/50">
                    <div className="flex justify-between items-center border-b border-gray-700 pb-2 mb-3">
                        <h2 className="text-lg font-bold text-white">Available Versions</h2>
                        <input type="text" placeholder="Search..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-md px-2 py-1 text-sm focus:ring-1 focus:ring-cyan-500 focus:outline-none" />
                    </div>
                    <div className="flex-grow space-y-3 overflow-y-auto pr-2">
                        {filteredVersions.length > 0 ? filteredVersions.map(v => (
                            <VersionCard
                                key={v.manifestId}
                                version={v}
                                isInstalled={installedVersions.includes(v.manifestId)}
                                isDownloading={isProcessing && currentDownload === v.manifestId}
                                isProcessing={isProcessing}
                                platform={platform}
                                onDownload={() => handleDownload(v)}
                                onPlay={() => handlePlay(v)}
                                onUninstall={() => handleUninstall(v)}
                            />
                        )) : (
                            <p className="text-center text-gray-400 mt-4">No versions found.</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);