import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MorphingShape } from "./amicro/morphing-shape";
import { OrigamiShape } from "./amicro/origami-shape";
import { TextShimmerWave } from "./amicro/text-shimmer-wave";
import { Typing } from "./amicro/typing";

export interface HomeConversationActionItem {
  id: "daily" | "revisit";
  accessibleName: string;
  title: string;
  description: string;
  onActivate(): void;
}

export interface HomeConversationActionsIsland {
  render(actions: readonly HomeConversationActionItem[]): void;
  unmount(): void;
}

export function createHomeConversationActionsIsland(host: HTMLElement): HomeConversationActionsIsland {
  const root = createRoot(host);
  return {
    render: (actions) => root.render(<HomeConversationActions actions={actions} />),
    unmount: () => root.unmount()
  };
}

function HomeConversationActions({ actions }: { actions: readonly HomeConversationActionItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const motionState = useHomeMotionState(containerRef);
  return (
    <div ref={containerRef} className="echoink-home-conversation-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`echoink-home-conversation-action is-${action.id}`}
          aria-label={action.accessibleName}
          onClick={() => action.onActivate()}
        >
          <span className="echoink-home-conversation-action-copy">
            {action.id === "daily"
              ? <TextShimmerWave text={action.title} {...motionState} />
              : <Typing text={action.title} {...motionState} />}
            <span className="echoink-home-conversation-action-description">{action.description}</span>
          </span>
          <span className="echoink-home-conversation-action-art" aria-hidden="true">
            {action.id === "daily"
              ? <MorphingShape {...motionState} />
              : <OrigamiShape {...motionState} />}
          </span>
        </button>
      ))}
    </div>
  );
}

function useHomeMotionState(ref: React.RefObject<HTMLElement | null>): {
  active: boolean;
  reducedMotion: boolean;
} {
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const [intersecting, setIntersecting] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const onWindowBlur = () => setWindowFocused(false);
    const onWindowFocus = () => setWindowFocused(document.hasFocus());
    const windowDeactivationEvent = "b\u006cur";
    window.addEventListener(windowDeactivationEvent, onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener(windowDeactivationEvent, onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return undefined;
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const target = ref.current;
    if (!target || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setIntersecting(entry?.isIntersecting ?? false),
      { threshold: 0.05 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ref]);

  return {
    active: pageVisible && windowFocused && intersecting && !reducedMotion,
    reducedMotion
  };
}
