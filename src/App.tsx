import { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Dashboard } from './pages/Dashboard';
import { LibraryPage } from './pages/LibraryPage';
import { FoldersPage } from './pages/FoldersPage';
import { ActivityPage } from './pages/ActivityPage';
import { StudioSyncPage } from './pages/StudioSyncPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';
import { FileReviewPage } from './pages/FileReviewPage';
import { SearchPage } from './pages/SearchPage';
import { CopilotPage } from './pages/CopilotPage';
import { AbletonPage } from './pages/AbletonPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { api } from './lib/api';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BounceConfirmModal } from './components/BounceConfirmModal';
import type { Page, SyncProgress } from './types';

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  // tri-state: null = loading, false = logged out, true = authed
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [syncProgresses, setSyncProgresses] = useState<Record<string, SyncProgress>>({});
  const [pendingAssociations, setPendingAssociations] = useState(0);
  const authChecked = useRef(false);

  useEffect(() => {
    if (authChecked.current) return;
    authChecked.current = true;
    api.auth.getToken()
      .then((token) => setAuthed(!!token))
      .catch(() => {
        // IPC error ≠ logged out — keep loading state briefly then default to logged out
        setTimeout(() => setAuthed((prev) => prev === null ? false : prev), 500);
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

  // Deep-link auth: main process receives deep link, exchanges JWT for wv_ token,
  // then sends the wv_ token here to update UI state.
  useEffect(() => {
    const handleToken = (token: unknown) => {
      if (typeof token === 'string' && token.length > 0) {
        // Token is already stored encrypted in the main process.
        // setToken here is idempotent — keeps syncAgent reference consistent.
        api.auth.setToken(token).then(() => setAuthed(true));
      }
    };
    // When a previously valid token becomes invalid (revoked / expired),
    // main process pauses the sync agent and signals the renderer.
    const handleAuthError = () => {
      setAuthed(false); // drop to login screen
    };
    api.on('auth:token-received', handleToken);
    api.on('auth:error', handleAuthError);
    return () => {
      api.off('auth:token-received', handleToken);
      api.off('auth:error', handleAuthError);
    };
  }, []);

  // Auto-updater: notify when update is downloaded and ready to install
  useEffect(() => {
    const handleUpdate = () => setUpdateReady(true);
    api.on('update:ready', handleUpdate);
    return () => api.off('update:ready', handleUpdate);
  }, []);

  // Poll pending association count every 60s
  const refreshPendingCount = useCallback(async () => {
    try {
      const items = await api.association.getPending();
      setPendingAssociations(Array.isArray(items) ? items.length : 0);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (authed) {
      refreshPendingCount();
      const interval = setInterval(refreshPendingCount, 60_000);
      return () => clearInterval(interval);
    }
  }, [authed, refreshPendingCount]);

  // Show nothing while auth state is loading (prevents flash-of-login)
  if (authed === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-black">
        <div className="w-5 h-5 border-2 border-white/20 border-t-cyan-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (authed === false) {
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
        <Sidebar currentPage={page} onNavigate={setPage} pendingAssociations={pendingAssociations} />
        <main className="flex-1 overflow-hidden bg-[#0A0A0A] relative">
          <BounceConfirmModal />
          <div className={page === 'dashboard' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Dashboard error"><Dashboard syncProgresses={syncProgresses} visible={page === 'dashboard'} onNavigate={setPage} /></ErrorBoundary></div>
          <div className={page === 'library' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Library error"><LibraryPage visible={page === 'library'} /></ErrorBoundary></div>
          <div className={page === 'folders' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Folders error"><FoldersPage visible={page === 'folders'} /></ErrorBoundary></div>
          <div className={page === 'studio' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Studio Sync error"><StudioSyncPage syncProgresses={syncProgresses} visible={page === 'studio'} /></ErrorBoundary></div>
          <div className={page === 'review' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="File Review error"><FileReviewPage visible={page === 'review'} onPendingCountChange={setPendingAssociations} /></ErrorBoundary></div>
          <div className={page === 'activity' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Activity error"><ActivityPage visible={page === 'activity'} /></ErrorBoundary></div>
          <div className={page === 'settings' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Settings error"><SettingsPage onLogout={() => setAuthed(false)} visible={page === 'settings'} /></ErrorBoundary></div>
          <div className={page === 'search' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Search error"><SearchPage visible={page === 'search'} /></ErrorBoundary></div>
          <div className={page === 'copilot' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Copilot error"><CopilotPage visible={page === 'copilot'} /></ErrorBoundary></div>
          <div className={page === 'ableton' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="DAW Sync error"><AbletonPage visible={page === 'ableton'} /></ErrorBoundary></div>
          <div className={page === 'diagnostics' ? 'h-full' : 'hidden'}><ErrorBoundary fallbackLabel="Diagnostics error"><DiagnosticsPage visible={page === 'diagnostics'} /></ErrorBoundary></div>
        </main>
      </div>
    </div>
  );
}
