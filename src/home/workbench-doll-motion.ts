export type WorkbenchAgentState = "unfinished" | "waiting" | "working" | "done" | "idle";
export interface DollPose { face: "happy" | "sad" | "curious" | "laugh"; angle: number; y: number; scaleX: number; head: number; skirt: number; left: number; right: number }
export function workbenchAgentState(groups: Record<"interrupted" | "waiting" | "running" | "completed", readonly unknown[]>): WorkbenchAgentState {
  return groups.interrupted.length ? "unfinished" : groups.waiting.length ? "waiting" : groups.running.length ? "working" : groups.completed.length ? "done" : "idle";
}
export function dollPose(state: WorkbenchAgentState, seconds?: number): DollPose {
  const pose: DollPose = { face: ({ unfinished: "sad", waiting: "curious", working: "happy", done: "laugh", idle: "happy" } as const)[state], angle: 0, y: 0, scaleX: 1, head: state === "waiting" ? 12 : state === "unfinished" ? 7 : state === "done" ? -2 : 0, skirt: 0, left: 0, right: 0 };
  if (seconds === undefined) return pose;
  const wave = Math.sin(seconds * Math.PI * 2 / 3);
  if (state === "working") {
    const local = seconds % 8, style = Math.floor(seconds / 8) % 3;
    const phase = local * Math.PI, gate = Math.min(1, local / .4, (8 - local) / .4);
    pose.angle = (style === 0 ? 9 : style === 1 ? 2 : 6) * Math.sin(phase) * gate;
    pose.y = style === 2 ? 0 : -3 * Math.sin(phase) ** 2 * gate;
    pose.scaleX = 1 + ((style === 1 ? Math.cos(local * Math.PI / 2) : style === 2 ? .8 + .2 * Math.cos(phase) : 1) - 1) * gate;
    pose.skirt = -11 * Math.sin(phase - .5) * gate;
    pose.left = 24 * Math.sin(phase + .6) * gate; pose.right = -28 * Math.sin(phase - .3) * gate;
  } else if (state === "waiting") {
    pose.head += 2 * wave; const pulse = seconds % 7;
    pose.y = pulse < 1 ? -1.4 * Math.sin(pulse * Math.PI) ** 2 : 0;
  } else if (state === "unfinished") { pose.scaleX = .98 + .02 * Math.cos(seconds * Math.PI / 3); pose.y = .5 * (1 - wave); }
  else if (state === "done") { pose.angle = 1.8 * wave; pose.skirt = -.8 * wave; pose.y = .5 * wave; }
  else pose.y = .8 * wave;
  return pose;
}
/** Head tilt, body yaw/rotation, then vertical movement keep the rope attached. */
export function dollStringEndpoint(pose: DollPose): { x: number; y: number } {
  const h = pose.head * Math.PI / 180, a = pose.angle * Math.PI / 180;
  const x = 25.6 * Math.sin(h) * pose.scaleX, y = 51 - 25.6 * Math.cos(h) - 26;
  return { x: 118 + x * Math.cos(a) - y * Math.sin(a), y: 26 + x * Math.sin(a) + y * Math.cos(a) + pose.y };
}
