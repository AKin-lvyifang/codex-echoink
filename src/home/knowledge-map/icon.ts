import { setIcon } from "obsidian";

/** DOM adaptation of the local Animate UI v2 icon gestures; original Obsidian SVG paths stay intact. */
export function knowledgeMapIcon(button: HTMLButtonElement, name: string): void {
  const icon = button.createSpan({ cls: "knowledge-map-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, name);
  const play = () => {
    if (
      button.disabled ||
      button.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    icon.getAnimations().forEach((animation) => animation.cancel());
    const transforms =
      name === "refresh-cw"
        ? ["rotate(0deg)", "rotate(200deg)", "rotate(180deg)"]
        : [
            "scale(1) rotate(0deg)",
            "scale(1.14) rotate(-12deg)",
            "scale(.96) rotate(5deg)",
            "scale(1) rotate(0deg)",
          ];
    icon.animate(
      transforms.map((transform) => ({ transform })),
      { duration: 520, easing: "ease-in-out" },
    );
  };
  button.addEventListener("pointerenter", play);
  button.addEventListener("pointerdown", play);
}
