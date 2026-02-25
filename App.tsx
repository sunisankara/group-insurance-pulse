
import React, { useState } from 'react';
import { fetchAINews, generatePodcastScript } from './services/gemini.ts';

declare var window: any;

const VERSION = "v0.9.9 (Security Focused)";

// --- CRYPTO UTILS ---
const ENCRYPTION_KEY_ALGO = { name: 'AES-GCM', length: 256 };
async function deriveKey(password: string, salt: Uint8Array) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  return window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, ENCRYPTION_KEY_ALGO, false, ['encrypt', 'decrypt']);
}
async function encryptData(data: string, password: string) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  return { encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))), salt: btoa(String.fromCharCode(...salt)), iv: btoa(String.fromCharCode(...iv)) };
}
async function decryptData(vault: any, password: string) {
  const salt = new Uint8Array(atob(vault.salt).split('').map(c => c.charCodeAt(0)));
  const iv = new Uint8Array(atob(vault.iv).split('').map(c => c.charCodeAt(0)));
  const encrypted = new Uint8Array(atob(vault.encrypted).split('').map(c => c.charCodeAt(0)));
  const key = await deriveKey(password, salt);
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

const App: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewScript, setPreviewScript] = useState<string>('');
  const [masterPassword, setMasterPassword] = useState('');
  const [isVaultLocked, setIsVaultLocked] = useState(() => !!localStorage.getItem('gh_vault'));
  const [activePat, setActivePat] = useState('');
  const [sources, setSources] = useState<any[]>([]);
  
  const [githubUser, setGithubUser] = useState((localStorage.getItem('gh_user') || '').trim());
  const [githubRepo, setGithubRepo] = useState((localStorage.getItem('gh_repo') || '').trim());

  const handleLockVault = async () => {
    if (!activePat || !masterPassword || !githubUser || !githubRepo) { 
      setError("Station setup requires: PAT, Repository, and Password."); 
      return; 
    }
    try {
      const vault = await encryptData(activePat, masterPassword);
      localStorage.setItem('gh_vault', JSON.stringify(vault));
      localStorage.setItem('gh_user', githubUser);
      localStorage.setItem('gh_repo', githubRepo);
      setIsVaultLocked(true);
      setActivePat('');
      setMasterPassword('');
      setError(null);
      setProgress("STATION ARMED");
    } catch (e) { setError("Encryption logic failed."); }
  };

  const handleUnlockVault = async () => {
    const vaultStr = localStorage.getItem('gh_vault');
    if (!vaultStr) { setError("No vault found on this device."); return; }
    try {
      const vault = JSON.parse(vaultStr);
      const pat = await decryptData(vault, masterPassword);
      setActivePat(pat);
      setIsVaultLocked(false);
      setError(null);
      setProgress("STATION DEPLOYED");
    } catch (e) { setError("Access Denied: Master Password incorrect."); }
  };

  const triggerDiagnostic = async () => {
    if (isVaultLocked || !activePat) { setError("Unlock console first."); return; }
    setProgress("SENDING HEARTBEAT...");
    try {
      const headers = { 'Authorization': `token ${activePat}`, 'Accept': 'application/vnd.github.v3+json' };
      const res = await fetch(`https://api.github.com/repos/${githubUser}/${githubRepo}/actions/workflows/test-cron.yml/dispatches`, {
        method: 'POST', headers, body: JSON.stringify({ ref: 'main' })
      });
      if (!res.ok) throw new Error(`Heartbeat Failed: Status ${res.status}. Verify PAT scopes (repo, workflow).`);
      setProgress("PULSE DETECTED");
    } catch (err: any) { setError(err.message); }
  };

  const generatePreview = async () => {
    setIsPreviewing(true);
    setError(null);
    setSources([]);
    setPreviewScript("");
    setProgress("SCANNING TEMPORAL DATA...");
    try {
      const news = await fetchAINews();
      setSources(news.sources || []);
      setProgress("SYNTHESIZING AGENTS...");
      const script = await generatePodcastScript(news.newsText);
      setPreviewScript(script);
      setProgress("SYNC COMPLETE");
    } catch (err: any) { 
      setError(`Sync Error: ${err.message}`); 
    } finally { setIsPreviewing(false); }
  };

  const triggerBroadcast = async () => {
    if (isVaultLocked || !activePat) { setError("Console Locked."); return; }
    setProgress("DISPATCHING BROADCAST...");
    try {
      const headers = { 'Authorization': `token ${activePat}`, 'Accept': 'application/vnd.github.v3+json' };
      const res = await fetch(`https://api.github.com/repos/${githubUser}/${githubRepo}/actions/workflows/podcast.yml/dispatches`, {
        method: 'POST', headers, body: JSON.stringify({ ref: 'main', inputs: { is_test: "false" } })
      });
      if (!res.ok) throw new Error(`Request Refused: ${res.status}. Ensure file exists at .github/workflows/podcast.yml`);
      setProgress("BROADCAST COMMENCING");
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 font-sans text-gray-100 selection:bg-blue-500/40">
      
      <div className="bg-gray-800 p-8 md:p-12 rounded-[3rem] border border-gray-700 shadow-2xl mb-12 flex flex-wrap justify-between items-center gap-10">
        <div className="flex items-center gap-8">
           <div className={`w-24 h-24 rounded-[2.5rem] flex items-center justify-center text-5xl shadow-2xl transition-all duration-500 ${isVaultLocked ? 'bg-gray-700 text-gray-500' : 'bg-blue-600 text-white shadow-blue-600/30'}`}>
             <i className={`fas ${isVaultLocked ? 'fa-shield-halved' : 'fa-satellite-dish'}`}></i>
           </div>
           <div>
              <h1 className="text-6xl font-black italic text-blue-400 tracking-tighter uppercase leading-none mb-2">AI Daily Pulse</h1>
              <p className="text-[11px] font-black text-gray-500 tracking-[0.5em] uppercase">Station Control | {VERSION}</p>
           </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <button onClick={generatePreview} disabled={isPreviewing} className="bg-gray-900 border border-gray-700 hover:border-blue-500 px-8 py-6 rounded-2xl font-black uppercase text-xs tracking-widest transition-all disabled:opacity-30">
             {isPreviewing ? <i className="fas fa-spinner fa-spin mr-3"></i> : <i className="fas fa-microchip mr-3"></i>}
             {isPreviewing ? 'Syncing...' : 'Real-time Preview'}
          </button>
          <button onClick={triggerBroadcast} disabled={isVaultLocked} className="bg-blue-600 hover:bg-blue-500 px-12 py-6 rounded-2xl font-black uppercase text-xs tracking-widest shadow-2xl shadow-blue-600/50 disabled:bg-gray-700 transition-all active:scale-95">
            <i className="fas fa-paper-plane mr-3"></i> Push Broadcast
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
        <div className="lg:col-span-2 space-y-12">
          <div className="bg-black/60 p-12 rounded-[3.5rem] border border-gray-800 shadow-2xl h-full flex flex-col min-h-[650px]">
             <div className="flex justify-between items-center mb-10">
                <div className="flex items-center gap-4">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                  <h3 className="text-[11px] font-black uppercase text-gray-500 tracking-[0.4em]">Intelligence Feed</h3>
                </div>
                <div className="flex gap-4">
                   <a href={`https://github.com/${githubUser}/${githubRepo}/actions`} target="_blank" className="text-[10px] font-black uppercase text-blue-400 hover:text-blue-300 transition-all flex items-center gap-2">
                     <i className="fas fa-external-link-alt"></i> Action Logs
                   </a>
                </div>
             </div>
             <div className="flex-1 bg-gray-950/80 rounded-[2.5rem] border border-gray-800 p-10 overflow-y-auto max-h-[600px] custom-scrollbar border-dashed">
                {previewScript ? (
                  <div className="space-y-8">
                    <pre className="whitespace-pre-wrap font-mono text-gray-300 leading-relaxed text-sm">{previewScript}</pre>
                    {sources.length > 0 && (
                      <div className="pt-8 border-t border-gray-800/50">
                        <h4 className="text-[10px] font-black uppercase text-gray-500 tracking-[0.4em] mb-4">Sources Grounded</h4>
                        <div className="grid grid-cols-1 gap-2">
                          {sources.map((chunk, i) => (
                            chunk.web && (
                              <a key={i} href={chunk.web.uri} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-xs text-blue-400 hover:text-blue-300">
                                <i className="fas fa-link text-[9px]"></i>
                                <span className="truncate">{chunk.web.title || chunk.web.uri}</span>
                              </a>
                            )
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-20">
                    <i className="fas fa-clock-rotate-left text-7xl mb-8"></i>
                    <p className="text-lg font-black uppercase tracking-widest">Awaiting Remote Sync</p>
                  </div>
                )}
             </div>
             <div className="mt-10 flex justify-between items-center">
                <p className="text-[11px] font-black uppercase text-gray-500 tracking-widest">Grounded Protocol: ACTIVE</p>
                <p className="text-[11px] font-black uppercase text-blue-500 tracking-widest">{progress || 'Ready'}</p>
             </div>
          </div>
        </div>

        <div className="space-y-12">
           <div className="bg-gray-800 p-10 rounded-[3rem] border border-gray-700 shadow-xl">
              <div className="flex items-center justify-between mb-10">
                <h3 className="text-[11px] font-black uppercase text-gray-400 tracking-[0.3em]">Credentials</h3>
                <i className={`fas ${isVaultLocked ? 'fa-lock text-red-500' : 'fa-unlock text-green-500'}`}></i>
              </div>
              {!localStorage.getItem('gh_vault') ? (
                <div className="space-y-5">
                  <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl mb-4">
                     <p className="text-[9px] text-blue-400 font-bold uppercase leading-tight">
                        <i className="fas fa-info-circle mr-2"></i>
                        Generate your PAT at: <br/>
                        <span className="font-mono lowercase break-all">GitHub > Settings > Developer Settings > PAT (Classic)</span><br/>
                        Required Scopes: <strong>repo</strong> and <strong>workflow</strong>.
                     </p>
                  </div>
                  <input value={githubUser} onChange={e => setGithubUser(e.target.value)} placeholder="GitHub Username" className="w-full bg-black/40 border border-gray-700 rounded-2xl px-6 py-5 text-xs font-mono text-blue-400 outline-none" />
                  <input value={githubRepo} onChange={e => setGithubRepo(e.target.value)} placeholder="Repository Name" className="w-full bg-black/40 border border-gray-700 rounded-2xl px-6 py-5 text-xs font-mono text-blue-400 outline-none" />
                  <input type="password" value={activePat} onChange={e => setActivePat(e.target.value)} placeholder="GitHub PAT (ghp_...)" className="w-full bg-black/40 border border-gray-700 rounded-2xl px-6 py-5 text-xs font-mono text-amber-400 outline-none" />
                  <input type="password" value={masterPassword} onChange={e => setMasterPassword(e.target.value)} placeholder="New Master Password" className="w-full bg-black/40 border border-gray-700 rounded-2xl px-6 py-5 text-xs font-mono text-white outline-none" />
                  <button onClick={handleLockVault} className="w-full bg-blue-600 py-5 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-blue-500 transition-all">Arm Station</button>
                </div>
              ) : isVaultLocked ? (
                <div className="space-y-8 flex flex-col items-center py-6">
                  <input type="password" value={masterPassword} onChange={e => setMasterPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleUnlockVault()} placeholder="Master Password" 
                    className="w-full bg-black/50 border border-gray-700 rounded-2xl px-6 py-5 text-center font-mono text-blue-400 outline-none" />
                  <button onClick={handleUnlockVault} className="w-full bg-blue-600 py-5 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-2xl shadow-blue-600/30 hover:bg-blue-500 transition-all">Unlock Console</button>
                </div>
              ) : (
                <div className="space-y-6">
                   <div className="flex items-center gap-5 p-6 bg-green-500/10 border border-green-500/20 rounded-3xl">
                      <div className="w-12 h-12 rounded-2xl bg-green-500/20 flex items-center justify-center text-green-500"><i className="fas fa-check"></i></div>
                      <div>
                        <p className="text-[11px] font-black uppercase text-green-500">Authenticated</p>
                        <p className="text-[10px] font-mono text-gray-500 truncate max-w-[140px]">{githubUser}/{githubRepo}</p>
                      </div>
                   </div>
                   <button onClick={triggerDiagnostic} className="w-full bg-amber-600/20 border border-amber-500/30 py-4 rounded-2xl font-black uppercase text-[9px] tracking-widest text-amber-500 hover:bg-amber-600/30 transition-all">
                    <i className="fas fa-bolt mr-2"></i> Test Remote Access
                   </button>
                   <button onClick={() => { localStorage.removeItem('gh_vault'); window.location.reload(); }} className="w-full bg-red-900/10 border border-red-900/30 py-4 rounded-2xl font-black uppercase text-[9px] tracking-widest text-red-500 hover:bg-red-900/20 transition-all">Wipe Local Credentials</button>
                   <button onClick={() => setIsVaultLocked(true)} className="w-full bg-gray-900 border border-gray-700 py-5 rounded-2xl font-black uppercase text-[9px] tracking-widest text-gray-500 hover:text-white transition-all">Lock Console</button>
                </div>
              )}
           </div>

           <div className="bg-gray-800 p-8 rounded-[3rem] border border-gray-700 shadow-xl space-y-6">
              <h3 className="text-[11px] font-black uppercase text-gray-400 tracking-[0.3em]">Critical Setup Checklist</h3>
              <div className="space-y-4">
                 <div className="flex gap-4 items-start">
                    <span className="bg-blue-600/20 text-blue-400 font-black text-[9px] w-6 h-6 flex items-center justify-center rounded-lg shrink-0">1</span>
                    <p className="text-[10px] text-gray-400 font-bold uppercase leading-relaxed">Repo Settings: <strong>Actions > General</strong>. Set "Workflow permissions" to <strong>"Read and write permissions"</strong>.</p>
                 </div>
                 <div className="flex gap-4 items-start">
                    <span className="bg-blue-600/20 text-blue-400 font-black text-[9px] w-6 h-6 flex items-center justify-center rounded-lg shrink-0">2</span>
                    <p className="text-[10px] text-gray-400 font-bold uppercase leading-relaxed">The <strong>API_KEY</strong> must be saved in <strong>Settings > Secrets and variables > Actions</strong>.</p>
                 </div>
                 <div className="flex gap-4 items-start">
                    <span className="bg-blue-600/20 text-blue-400 font-black text-[9px] w-6 h-6 flex items-center justify-center rounded-lg shrink-0">3</span>
                    <p className="text-[10px] text-gray-400 font-bold uppercase leading-relaxed">Your <strong>PAT</strong> must have both <strong>repo</strong> and <strong>workflow</strong> scopes checked during creation.</p>
                 </div>
              </div>
           </div>
        </div>

      </div>
      
      {error && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-red-600 text-white px-10 py-7 rounded-[2rem] shadow-2xl flex items-center gap-8 animate-in fade-in slide-in-from-bottom-10 z-50">
           <i className="fas fa-triangle-exclamation text-2xl"></i>
           <p className="font-bold text-sm leading-tight max-w-lg">{error}</p>
           <button onClick={() => setError(null)}><i className="fas fa-xmark"></i></button>
        </div>
      )}
    </div>
  );
};

export default App;
