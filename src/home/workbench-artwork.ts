import { ownedSvg } from "../ui/owned-dom";
import weather from "../../assets/workbench/00-weather-master.svg";
import avatar from "../../assets/workbench/06-card-avatar-wheel.svg";
import knowledge from "../../assets/workbench/07-card-knowledge.svg";
import appearance from "../../assets/workbench/08-card-appearance.svg";
import diary from "../../assets/workbench/09-card-diary.svg";
import reading from "../../assets/workbench/10-card-close-reading.svg";
import english from "../../assets/workbench/11-card-english-diary.svg";
import pdf from "../../assets/workbench/12-card-pdf-notes.svg";
import { AGENT_AVATAR_PRESETS } from "../ui/agent-avatar-presets";

export const WORKBENCH_ART = { weather, avatar, knowledge, appearance, diary, reading, english, pdf };
let instance = 0;
/** Parse trusted packaged SVG, with a fresh namespace per instance (including nested avatars). */
export function inlineWorkbenchArt(doc: Document, source: string): SVGSVGElement {
  // Test bundlers and the existing avatar pipeline supply data URLs; product artwork is text.
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    source = source.slice(0, comma).includes(";base64") ? atob(source.slice(comma + 1)) : decodeURIComponent(source.slice(comma + 1));
  }
  const parsed = new (doc.defaultView?.DOMParser ?? DOMParser)().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Invalid workbench artwork");
  const svg = doc.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  const prefix = `wb-art-${++instance}-`, ids = new Map<string, string>();
  svg.querySelectorAll<SVGElement>("[id]").forEach(node => { const id = node.id; ids.set(id, prefix + id); node.dataset.layer = id; node.id = prefix + id; });
  for (const node of [svg, ...Array.from(svg.querySelectorAll("*"))]) for (const attr of Array.from(node.attributes)) {
    let value = attr.value;
    for (const [id, next] of ids) { value = value.replaceAll(`url(#${id})`, `url(#${next})`); if (value === `#${id}`) value = `#${next}`; }
    if (value !== attr.value) node.setAttribute(attr.name, value);
  }
  return svg;
}
export function avatarWheelArt(doc: Document, primary = "sol"): SVGSVGElement {
  const svg = inlineWorkbenchArt(doc, avatar);
  [primary, "rio", "lin", "nova", "aya", "han"].forEach((id, index) => {
    const circle = svg.querySelector<SVGCircleElement>(`[data-layer="avatar-${index ? index : "main"}"]`);
    const preset = AGENT_AVATAR_PRESETS.find(p => p.id === id) ?? AGENT_AVATAR_PRESETS[0];
    if (!circle) return;
    const r = Number(circle.getAttribute("r")) - .6, cx = Number(circle.getAttribute("cx")), cy = Number(circle.getAttribute("cy"));
    const content = inlineWorkbenchArt(doc, preset.assetPath);
    content.setAttribute("x", String(cx - r)); content.setAttribute("y", String(cy - r));
    content.setAttribute("width", String(2 * r)); content.setAttribute("height", String(2 * r));
    const clip = ownedSvg(doc, "clipPath"); clip.id = `${circle.id}-clip`;
    const mask = circle.cloneNode(false) as SVGCircleElement; mask.removeAttribute("id"); mask.removeAttribute("data-layer"); mask.setAttribute("r", String(r)); clip.append(mask);
    svg.prepend(clip);
    const group = ownedSvg(doc, "g"); group.setAttribute("clip-path", `url(#${clip.id})`); group.append(content);
    circle.before(group);
  });
  return svg;
}
