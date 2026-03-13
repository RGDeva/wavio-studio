import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Dashboard } from './pages/Dashboard';
import { LibraryPage } from './pages/LibraryPage';
import { FoldersPage } from './pages/FoldersPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';
import { api } from './lib/api';
import type { Page, SyncProgress } from './types';

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [syncProgresses, setSyncProgresses] = useState<Record<string, SyncProgress>>({});

  useEffect(() => {
    api.auth.getToken().then((token) => {
      setAuthed(!!token);
    });
  }, []);

  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const handleProgress = (progress: unknown) => {
      const p = progress as SyncProgress;
      setSyncProgresses((prev) => ({ ...prev, [p.itemId]: p }));
    };
    api.on('sync:progress', handleProgress);
    return () => api.off('sync:progress', handleProgress);
  }, []);

  // Deep-link auth: wavi://auth?token=<privy_jwt> received while app is open
  useEffect(() => {
    const handleToken = (token: unknown) => {
      if (typeof token === 'string' && token.length > 0) {
        api.auth.setToken(token).then(() => setAuthed(true));
      }
    };
    api.on('auth:token-received', handleToken);
    return () => api.off('auth:token-received', handleToken);
  }, []);

  // Auto-updater: notify when update is downloaded and ready to install
  useEffect(() => {
    const handleUpdate = () => setUpdateReady(true);
    api.on('update:ready', handleUpdate);
    return () => api.off('update:ready', handleUpdate);
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-black">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  return (
    <div className="flex flex-col h-screen bg-black overflow-hidden">
      <TitleBar />
      {updateReady && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20 text-xs text-cyan-400">
          <span>A new version of Wavi Studio is ready to install.</span>
          <button
            className="underline hover:text-cyan-300 transition-colors"
            onClick={() => (window as any).waviAPI?.app?.relaunch?.()}
          >
            Restart to update
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar currentPage={page} onNavigate={setPage} />
        <main className="flex-1 overflow-hidden bg-[#0A0A0A]">
          {page === 'dashboard' && <Dashboard syncProgresses={syncProgresses} />}
          {page === 'library' && <LibraryPage />}
          {page === 'folders' && <FoldersPage />}
          {page === 'activity' && <ActivityPage />}
          {page === 'settings' && <SettingsPage onLogout={() => setAuthed(false)} />}
        </main>
      </div>
    </div>
  );
}
