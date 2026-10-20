import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { createIPadComposer } from "./composer";
import { ipadAvatar, ipadDateGroup, ipadElement as el, ipadIcon, ipadStatus, ipadTasks, ipadTaskStatus, ipadTaskSummary, ipadTaskTime, ipadTaskProjection } from "./workbench-elements";

/** A single Agent's list lives entirely in the native right pane. */
export function createAgentPage(ctx: IPadPageContext, agentId: string): MobileShellPage {
  const { document, host } = ctx;
  const content = el(document, "div", "pd-agent-page");
  const identity = el(document, "header", "pd-agent-identity");
  const list = el(document, "div", "pd-agent-tasks");
  const composer = createIPadComposer(ctx, { agentId });
  content.append(identity, list);
  let disposed = false, signature = "", day = new Date().toDateString();
  const projections = new Map<string, string>();
  const page: MobileShellPage = { id: `ipad-agent-${agentId}`, title: "Agent", header: "content", content, footer: composer.element, canLeave: composer.canLeave };
  const render = (force = false) => {
    if (disposed) return;
    const agent = host.settings().agentRegistry.agents.find(item => item.id === agentId);
    const tasks = ipadTasks(host.store.state.sessions).filter(task => task.agentId === agentId);
    const next = day + JSON.stringify(agent) + ipadTaskProjection(tasks);
    if (!force && next === signature) return;
    signature = next; projections.clear();
    for (const task of tasks) projections.set(task.id, ipadTaskProjection([task]));
    identity.replaceChildren(); list.replaceChildren();
    if (!agent) {
      list.append(el(document, "div", "pd-empty", "这个 Agent 已被删除。")); composer.element.hidden = true; return;
    }
    page.title = agent.name; composer.element.hidden = false;
    const copy = el(document, "div", "pd-agent-identity-copy");
    copy.append(el(document, "div", "pd-agent-name", agent.name), el(document, "div", "pd-agent-position", agent.position));
    const count = el(document, "span", "pd-agent-count", `${tasks.length} 件事`);
    const edit = el(document, "button", "pd-agent-edit"); edit.type = "button"; edit.setAttribute("aria-label", `编辑 ${agent.name}`);
    edit.append(ipadIcon(document, "pencil"));
    edit.addEventListener("click", () => { void ctx.navigate({ kind: "agent-form", agentId }).catch(ctx.error); });
    identity.append(ipadAvatar(document, agent), copy, count, edit);
    if (!tasks.length) { list.append(el(document, "div", "pd-empty", `还没有交给${agent.name}的事。`)); return; }
    const groups = new Map<string, typeof tasks>();
    const active = tasks.filter(task => ipadTaskStatus(task) !== "completed").sort((a, b) => b.updatedAt - a.updatedAt);
    if (active.length) groups.set("进行中", active);
    for (const task of tasks.filter(task => ipadTaskStatus(task) === "completed").sort((a, b) => ipadTaskTime(b) - ipadTaskTime(a))) {
      const label = ipadDateGroup(ipadTaskTime(task));
      groups.set(label, [...(groups.get(label) ?? []), task]);
    }
    for (const [label, items] of groups) {
      const group = el(document, "section", "pd-agent-task-group"); group.setAttribute("aria-label", label);
      group.append(el(document, "h2", "pd-task-group-label", label));
      for (const task of items) {
        const card = el(document, "button", "pd-list-task"); card.type = "button"; card.dataset.taskId = task.id;
        const top = el(document, "span", "pd-list-task-top");
        top.append(el(document, "span", "pd-list-task-title", task.title), ipadStatus(document, task));
        card.append(top, el(document, "span", "pd-sub pd-task-summary", ipadTaskSummary(task)));
        card.addEventListener("click", () => { void ctx.navigate({ kind: "task", taskId: task.id }).catch(ctx.error); }); group.append(card);
      }
      list.append(group);
    }
  };
  const runtime = host.runtime.subscribe(id => {
    if (!id) { render(); return; }
    const task = host.store.getSession(id), next = task ? ipadTaskProjection([task]) : "";
    // Streaming a token does not rebuild the list or its input node.
    if ((task?.agentId === agentId || projections.has(id)) && projections.get(id) !== next) render();
  });
  const identitySubscription = host.services.subscribeIdentity(() => render());
  const facts = host.workbench.subscribe(() => render());
  const clock = document.defaultView?.setInterval(() => {
    const today = new Date().toDateString(), changed = day !== today; day = today;
    if (changed || ctx.shell.activePageId === page.id && host.store.state.sessions.some(task => task.agentId === agentId && task.taskStatus === "running")) render(true);
  }, 30_000);
  render();
  page.dispose = () => {
    if (disposed) return; disposed = true; runtime(); identitySubscription(); facts(); composer.dispose(); document.defaultView?.clearInterval(clock);
  };
  return page;
}
