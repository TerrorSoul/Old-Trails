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

const VersionCard = ({ version, isInstalled, isDownloading, isProcessing, runningGame, onDownload, onPlay, onUninstall }) => {
    const match = version.name.match(/^([\d\.]+) (.*)/);
    const versionNumber = match ? match[1] : '';
    const updateName = match ? match[2] : version.name;

    const isThisGameRunning = runningGame === version.name;
    const isAnyGameRunning = runningGame !== null;

    return (
        <div className={`bg-gray-800 p-4 rounded-lg flex items-center justify-between transition-all duration-300 ${isDownloading ? 'ring-2 ring-cyan-500' : 'ring-1 ring-gray-700'}`}>
            <div>
                {versionNumber && <span className="font-bold text-lg text-cyan-400 mr-2">{versionNumber}</span>}
                <span className="font-semibold text-white">{updateName}</span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
                {isInstalled ? (
                    <>
                        <button 
                            onClick={onPlay} 
                            disabled={isAnyGameRunning || isProcessing}
                            className={`font-bold py-2 px-4 rounded-md text-sm transition-colors text-white ${isThisGameRunning ? 'bg-yellow-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'} disabled:bg-gray-600 disabled:cursor-not-allowed`}
                        >
                            {isThisGameRunning ? 'Running...' : 'Play'}
                        </button>
                        <button 
                            onClick={onUninstall} 
                            disabled={isAnyGameRunning || isProcessing}
                            className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-md text-sm transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed"
                        >
                            Uninstall
                        </button>
                    </>
                ) : (
                    <button
                        onClick={onDownload}
                        disabled={isProcessing || isAnyGameRunning}
                        className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-md text-sm transition-colors"
                    >
                        {isDownloading ? 'Installing...' : 'Install'}
                    </button>
                )}
            </div>
        </div>
    );
};

const AuthPrompt = ({ onCodeSubmit, type }) => {
    const [steamGuardCode, setSteamGuardCode] = useState('');
    const handleSubmit = (e) => {
        e.preventDefault();
        if (!steamGuardCode) return;
        onCodeSubmit(steamGuardCode);
        setSteamGuardCode('');
    };

    let promptText = "Please enter the code from your authenticator app.";
    if (type === 'mobile') {
        return (
            <div className="p-4 bg-gray-700/50 rounded-lg space-y-3 border border-yellow-500/30">
                <div className="text-center">
                    <p className="font-semibold text-yellow-300">Authentication Required</p>
                    <p className="text-sm text-gray-300">Please approve the sign in request on your Steam Mobile App.</p>
                </div>
            </div>
        );
    }
    if (type === 'email') {
        promptText = "Please enter the auth code sent to your email address.";
    }
    
    return (
        <div className="p-4 bg-gray-700/50 rounded-lg space-y-3 border border-yellow-500/30">
            <div className="text-center">
                <p className="font-semibold text-yellow-300">Authentication Required</p>
                <p className="text-sm text-gray-300">{promptText}</p>
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
    const [steamPath, setSteamPath] = useState('');
    const [steamFound, setSteamFound] = useState(true); // Assume found initially to avoid flicker
    const [isInitializing, setIsInitializing] = useState(true);
    const [isProcessing, setIsProcessing] = useState(false);
    const [currentDownload, setCurrentDownload] = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('Initializing...');
    const [authPromptType, setAuthPromptType] = useState(null);
    const [runningGame, setRunningGame] = useState(null);

    const fetchInstalledVersions = async () => {
        const installed = await window.electronAPI.getInstalledVersions();
        setInstalledVersions(installed);
    };

    useEffect(() => {
        const setup = async () => {
            const creds = await window.electronAPI.getCredentials();
            setUsername(creds.username || '');
            setPassword(creds.password || '');
            setSteamPath(creds.downloadPath || '');
            
            const version = await window.electronAPI.getAppVersion();
            setAppVersion(version);
            
            fetchInstalledVersions();
        };

        setup();

        window.electronAPI.onVersionsLoaded(setVersions);
        window.electronAPI.uiReady();

        const handleSteamFound = ({ path, versionsPath }) => {
            setSteamFound(true);
            setSteamPath(versionsPath);
        };

        const handleSteamNotFound = () => {
            setSteamFound(false);
            setStatusMessage('Steam Trailmakers installation not found.');
        };
        
        const handleInitializationComplete = () => {
            setIsInitializing(false);
        };

        const handleStatusUpdate = (message) => {
            setStatusMessage(message);
            const lowerCaseMessage = message.toLowerCase();
            if (!lowerCaseMessage.includes('authentication required') && !lowerCaseMessage.includes('confirmation required')) {
                setAuthPromptType(null);
            }
        };

        const handleDownloadComplete = ({ success }) => {
            if (success) fetchInstalledVersions();
            setIsProcessing(false);
            setCurrentDownload(null);
            setAuthPromptType(null);
            setStatusMessage(success ? 'Installation Complete!' : 'Download failed.');
            setTimeout(() => setStatusMessage('Ready.'), 5000);
        };

        const handleRefreshVersions = () => fetchInstalledVersions();
        const handleGameLaunched = (versionName) => setRunningGame(versionName);
        const handleGameClosed = () => setRunningGame(null);
        
        window.electronAPI.onSteamFound(handleSteamFound);
        window.electronAPI.onSteamNotFound(handleSteamNotFound);
        window.electronAPI.onInitializationComplete(handleInitializationComplete);
        window.electronAPI.onStatusUpdate(handleStatusUpdate);
        window.electronAPI.onDownloadProgress(({ progress }) => setDownloadProgress(progress));
        window.electronAPI.onSteamGuardRequired(() => setAuthPromptType('code'));
        window.electronAPI.onSteamMobileRequired(() => setAuthPromptType('mobile'));
        window.electronAPI.onSteamEmailRequired(() => setAuthPromptType('email'));
        window.electronAPI.onDownloadComplete(handleDownloadComplete);
        window.electronAPI.onGameLaunched(handleGameLaunched);
        window.electronAPI.onGameClosed(handleGameClosed);
        window.electronAPI.onRefreshInstalledVersions(handleRefreshVersions);

        return () => {
            [
                'versions-loaded', 'steam-found', 'steam-not-found', 'initialization-complete',
                'status-update', 'download-progress', 'steam-guard-required', 
                'steam-mobile-required', 'steam-email-required', 'download-complete', 
                'game-launched', 'game-closed', 'refresh-installed-versions'
            ].forEach(channel => window.electronAPI.removeAllListeners(channel));
        };
    }, []);

    const handleDownload = (version) => {
        if (!username || !password) return setStatusMessage('Error: Username and password are required.');
        if (!steamFound) return setStatusMessage('Error: Steam Trailmakers installation not found.');
        
        setIsProcessing(true);
        setCurrentDownload(version.manifestId);
        setDownloadProgress(0);
        setAuthPromptType(null);
        window.electronAPI.startDownload({ username, password, version });
    };

    const handlePlay = (version) => {
        setStatusMessage(`Launching ${version.name}...`);
        window.electronAPI.launchGame({ versionName: version.name });
    };

    const handleUninstall = async (version) => {
        setStatusMessage(`Uninstalling ${version.name}...`);
        const result = await window.electronAPI.uninstallVersion({ versionName: version.name });
        setStatusMessage(result.message);
        if (result.success) fetchInstalledVersions();
    };

    const handleFactoryReset = async () => {
        setStatusMessage('Waiting for confirmation...');
        const result = await window.electronAPI.factoryReset();
        setStatusMessage(result.message);
        if (result.success) fetchInstalledVersions();
    };

    const handleCodeSubmit = (code) => {
        setAuthPromptType(null);
        setStatusMessage('Submitting code...');
        window.electronAPI.submitSteamGuard(code);
    };

    const filteredVersions = versions.filter(v => v.name.toLowerCase().includes(searchTerm.toLowerCase()));
    const isBusy = isProcessing || runningGame !== null || isInitializing;

    return (
        <div className="h-screen flex flex-col bg-gray-900 text-gray-200 select-none">
            <TitleBar appVersion={appVersion} />
            <div className="flex-grow flex p-4 gap-4 overflow-hidden">
                <div className="w-1/3 flex-shrink-0 flex flex-col gap-4 min-w-0">
                    <div className="bg-gray-800 p-4 rounded-lg border border-gray-700/50">
                        <h2 className="text-lg font-bold text-white border-b border-gray-700 pb-2 mb-3">Settings</h2>
                        <fieldset disabled={isBusy} className="space-y-3">
                            <input type="text" placeholder="Steam Username" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:outline-none disabled:opacity-50" />
                            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-sm focus:ring-2 focus:ring-cyan-500 focus:outline-none disabled:opacity-50" />
                            <div className="text-sm">
                                <span className="font-semibold">Steam Status:</span>
                                <span className={`ml-2 ${steamFound ? 'text-green-400' : 'text-red-400'}`}>
                                   {steamFound ? 'Found' : 'Not Found'}
                               </span>
                           </div>
                           {steamPath && (
                               <div className="text-xs text-gray-400 break-all">
                                   <span className="font-semibold">Path:</span> {steamPath}
                               </div>
                           )}
                       </fieldset>
                   </div>
                   
                   {isProcessing && authPromptType && <AuthPrompt onCodeSubmit={handleCodeSubmit} type={authPromptType} />}
                   
                   <div className="flex-grow bg-gray-800 p-4 rounded-lg border border-gray-700/50 flex flex-col justify-center">
                       <h3 className="text-md font-bold text-white mb-2">Status</h3>
                       <p className="text-cyan-300 text-sm h-10">{statusMessage}</p>
                       {(isProcessing || isInitializing) && (
                            <div className="w-full bg-gray-700 rounded-full h-4 mt-2 shadow-inner overflow-hidden">
                               <div 
                                    className={`h-4 rounded-full transition-all duration-500 ${isInitializing ? 'bg-gray-500 animate-pulse' : 'bg-cyan-500'}`}
                                    style={{ width: isInitializing ? '100%' : `${downloadProgress}%` }}>
                               </div>
                           </div>
                       )}
                   </div>
               </div>

               <div className="w-2/3 flex flex-col bg-gray-800 p-4 rounded-lg border border-gray-700/50">
                   <div className="flex justify-between items-center border-b border-gray-700 pb-2 mb-3">
                       <div className="flex items-center gap-3">
                           <h2 className="text-lg font-bold text-white">Available Versions</h2>
                           {installedVersions.length > 0 && (
                               <button 
                                   onClick={handleFactoryReset} 
                                   disabled={isBusy}
                                   className="p-1 rounded-full text-gray-400 hover:bg-red-800 hover:text-white disabled:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                                   title="Factory Reset All Versions"
                               >
                                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>
                               </button>
                           )}
                       </div>
                       <input type="text" placeholder="Search..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-md px-2 py-1 text-sm focus:ring-1 focus:ring-cyan-500 focus:outline-none" />
                   </div>
                   <div className="flex-grow space-y-3 overflow-y-auto pr-2">
                       {!steamFound ? (
                           <div className="text-center text-gray-400 mt-8">
                               <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" className="mx-auto mb-4 text-gray-600" viewBox="0 0 16 16">
                                   <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                               </svg>
                               <p className="text-lg font-semibold mb-2">Steam Trailmakers Not Found</p>
                               <p className="text-sm">Please install Trailmakers through Steam, then restart this application.</p>
                           </div>
                       ) : isInitializing ? (
                            <div className="text-center text-gray-400 mt-8">
                                <p>Loading...</p>
                            </div>
                       ) : filteredVersions.length > 0 ? filteredVersions.map(v => (
                           <VersionCard
                               key={v.manifestId}
                               version={v}
                               isInstalled={installedVersions.includes(v.manifestId)}
                               isDownloading={isProcessing && currentDownload === v.manifestId}
                               isProcessing={isBusy}
                               runningGame={runningGame}
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
