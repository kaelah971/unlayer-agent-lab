/**
 * Small React error boundary for the inspector region (M3 reliability).
 *
 * A crash while rendering a proposal diff or native result must not blank
 * the whole application (and must never strand the canvas). The boundary
 * shows a fallback with a retry that resets back to the proposal view.
 */
import { Component } from 'react';
import type { ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class InspectorErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert">
          <h3>Proposed Change</h3>
          <p>The change inspector failed to render. Your design was not modified.</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
