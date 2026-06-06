import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
          <AlertTriangle className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white/70">
            {this.props.fallbackLabel ?? 'Something went wrong'}
          </p>
          <p className="text-xs text-white/30 mt-1 font-mono max-w-sm break-all">
            {this.state.error.message}
          </p>
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/50 transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Try again
        </button>
      </div>
    );
  }
}
