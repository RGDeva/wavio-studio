import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface LoginPageProps {
  onLogin: () => void;
}

function getAuthUrl(): string {
  const apiBase = window.waviAPI?.config?.apiBase ?? 'https://wavi.stream/api';
  const channel = window.waviAPI?.config?.channel ?? 'production';
  const webBase = apiBase.replace(/\/api$/, '');
  return `${webBase}/auth?desktop=1&channel=${channel}`;
}

// Short, non-reversible diagnostic ID — safe to display/copy, never a token.
function makeDiagnosticId(): string {
  return `wv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [waiting, setWaiting] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticId, setDiagnosticId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!waiting) return;

    // Main process exchanged the Privy JWT for a wv_ token and stored it encrypted.
    // The wv_ token is passed here only to update authed state — it is NOT stored again by the renderer.
    const handleReceived = (incoming: unknown) => {
      const token = incoming as string;
      if (token && typeof token === 'string') {
        // Set the token in main process (idempotent — already stored, but keeps syncAgent reference fresh)
        api.auth.setToken(token).then(onLogin);
      }
    };

    const handleExchanging = () => setExchanging(true);

    const handleError = (reason: unknown) => {
      setExchanging(false);
      setWaiting(false);
      setDiagnosticId(makeDiagnosticId());
      if (reason === 'exchange-failed') {
        setError('Sign in failed — check your internet connection and try again.');
      } else {
        setError('Sign in failed. Please try again.');
      }
    };

    api.on('auth:token-received', handleReceived);
    api.on('auth:exchanging', handleExchanging);
    api.on('auth:error', handleError);
    return () => {
      api.off('auth:token-received', handleReceived);
      api.off('auth:exchanging', handleExchanging);
      api.off('auth:error', handleError);
    };
  }, [waiting, onLogin]);

  const handleSignIn = () => {
    setError(null);
    setDiagnosticId(null);
    api.shell.openExternal(getAuthUrl());
    setWaiting(true);
  };

  const handleCopyDiagnosticId = () => {
    if (!diagnosticId) return;
    const channel = window.waviAPI?.config?.channel ?? 'production';
    navigator.clipboard.writeText(`${diagnosticId} (channel=${channel})`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="h-screen bg-black flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-xs">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <img src="./icon.png" alt="Wavi" className="w-8 h-8 object-contain" />
          <h1 className="text-2xl font-bold text-white tracking-tight">Wavi Studio</h1>
        </div>

        <div className="bg-[#111] border border-[#222] rounded-2xl p-6 space-y-4 text-center">
          {error && (
            <div className="space-y-2">
              <p className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2">{error}</p>
              <div className="flex items-center justify-center gap-3 text-[11px]">
                <button onClick={handleSignIn} className="text-cyan-400 hover:text-cyan-300">Retry</button>
                <span className="text-white/20">·</span>
                <button onClick={() => api.shell.openExternal(getAuthUrl())} className="text-cyan-400 hover:text-cyan-300">
                  Open browser again
                </button>
                {diagnosticId && (
                  <>
                    <span className="text-white/20">·</span>
                    <button onClick={handleCopyDiagnosticId} className="text-white/40 hover:text-white/60">
                      {copied ? 'Copied!' : `Copy diagnostic ID`}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {!waiting ? (
            <>
              <div>
                <p className="text-sm font-semibold text-white/80 mb-1">Sign in to sync your DAW</p>
                <p className="text-xs text-white/30">
                  Uses the same account as wavi.stream
                </p>
              </div>
              <button
                onClick={handleSignIn}
                className="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-sm rounded-lg py-3 transition-colors"
              >
                Sign in with Wavi
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center py-2">
                <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-sm text-white/60">
                {exchanging ? 'Securing your session…' : 'Complete sign in in your browser…'}
              </p>
              <button
                onClick={() => { setWaiting(false); setExchanging(false); }}
                className="text-xs text-white/20 hover:text-white/40 transition-colors"
              >
                Cancel
              </button>
            </>
          )}
        </div>

        <p className="text-center text-xs text-white/20 mt-6">
          Your session is encrypted at rest.
        </p>
      </div>
    </div>
  );
}
