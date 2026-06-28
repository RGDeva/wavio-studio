import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface LoginPageProps {
  onLogin: () => void;
}

function getAuthUrl(): string {
  const apiBase = window.waviAPI?.config?.apiBase ?? 'https://wavi.stream/api';
  const webBase = apiBase.replace(/\/api$/, '');
  return `${webBase}/auth?desktop=1`;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [waiting, setWaiting] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    api.shell.openExternal(getAuthUrl());
    setWaiting(true);
  };

  return (
    <div className="h-screen bg-black flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-xs">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <img src="/icon.png" alt="Wavi" className="w-8 h-8 object-contain" />
          <h1 className="text-2xl font-bold text-white tracking-tight">Wavi Studio</h1>
        </div>

        <div className="bg-[#111] border border-[#222] rounded-2xl p-6 space-y-4 text-center">
          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2">{error}</p>
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
