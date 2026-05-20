import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("app render failure", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen w-full bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-destructive/40 bg-card p-5 shadow-xl font-mono">
          <div className="text-sm uppercase tracking-wider text-destructive mb-2">
            Platform view failed safely
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            A UI component threw an error. Market-data engines were not changed; reload the view after checking the console or server logs.
          </p>
          <pre className="max-h-40 overflow-auto rounded bg-black/30 p-3 text-[11px] text-white/70 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            className="mt-4 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={() => window.location.reload()}
          >
            Reload platform
          </button>
        </div>
      </div>
    );
  }
}
