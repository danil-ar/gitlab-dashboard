import { Component } from "react";

export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 text-sm text-gray-600">
        <p>Something went wrong while showing this page.</p>
        <button
          onClick={() => window.location.reload()}
          className="px-3 py-1.5 border border-gray-200 rounded-md bg-white hover:bg-gray-50 text-gray-700"
        >
          Reload
        </button>
      </div>
    );
  }
}
