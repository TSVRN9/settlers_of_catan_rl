// A panel that belongs to an edge. Its dock is its motion: it arrives from that edge when
// its view arrives (through the view transition) or when state brings it in (through
// @starting-style), and leaves the same way. The name must be unique on screen: `view-panel`.
import type { CSSProperties, ReactNode } from "react";

export type Side = "l" | "r" | "t" | "b";

interface Props { name: string; side: Side; className?: string; style?: CSSProperties; children?: ReactNode }

export default function Dock({ name, side, className, style, children }: Props) {
  const vt = { viewTransitionName: name, viewTransitionClass: `dock-${side}` } as CSSProperties;
  return (
    <div className={`arrive dock-${side}${className ? ` ${className}` : ""}`} style={{ ...vt, ...style }}>
      {children}
    </div>
  );
}
