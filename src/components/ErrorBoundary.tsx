import { Component, type ReactNode, type ErrorInfo } from 'react';
import { ErrorState } from './ui/ErrorState';

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
      <div className="flex items-center justify-center h-full">
        <ErrorState
          title={this.props.fallbackLabel ?? 'Something went wrong'}
          description="This section failed to render. You can retry without losing the rest of the app."
          detail={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      </div>
    );
  }
}
