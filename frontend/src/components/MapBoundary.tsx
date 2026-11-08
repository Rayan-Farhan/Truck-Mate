import { Component, type ReactNode } from 'react';
import { Map } from 'lucide-react';

export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="map-loading map-unavailable" role="status">
          <Map size={25} />
          <strong>Map rendering is unavailable.</strong>
          <span>Route comparison and the checkpoint table remain available.</span>
        </div>
      );
    return this.props.children;
  }
}
