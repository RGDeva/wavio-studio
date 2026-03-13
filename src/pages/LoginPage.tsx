import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface LoginPageProps {
  onLogin: () => void;
}

const AUTH_URL = 'https://wavi.stream/auth?desktop=1';

export function LoginPage({ onLogin }: LoginPageProps) {
  const [waiting, setWaiting] = useState(false);

  // Listen for deep-link JWT from browser after Privy login
  useEffect(() => {
    if (!waiting) return;
    const handle = (incoming: unknown) => {
      const token = incoming as string;
      if (token) {
        api.auth.setToken(token).then(onLogin);
      }
    };
    api.on('auth:token-received', handle);
    return () => api.off('auth:token-received', handle);
  }, [waiting, onLogin]);

  const handleSignIn = () => {
    api.shell.openExternal(AUTH_URL);
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
              <p className="text-sm text-white/60">Complete sign in in your browser…</p>
              <button
                onClick={() => setWaiting(false)}
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
