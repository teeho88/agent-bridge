import type { PixelActorState, PixelOfficeSceneState, PixelTransition } from './types.js';
import { MAX_QUEUED_TRANSITIONS } from './transitions.js';

function textElement(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function hueFor(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}

export class PixelOfficeSceneController {
  private actors = new Map<string, HTMLButtonElement>();
  private actorState = new Map<string, PixelActorState>();
  private transitions: PixelTransition[] = [];
  private played = new Set<string>();
  private playing = false;
  private selectedActorId = '';

  constructor(private root: HTMLElement) {
    root.addEventListener('click', event => {
      const actor = (event.target as Element | null)?.closest?.('[data-office-actor]') as HTMLElement | null;
      if (!actor) return;
      this.selectedActorId = actor.dataset.officeActor || '';
      this.renderInspector();
    });
  }

  apply(state: PixelOfficeSceneState, transitions: PixelTransition[]): void {
    this.root.dataset.status = state.globalStatus;
    this.root.dataset.activity = state.dominantActivity;
    this.root.setAttribute('aria-label', `Pixel Office: ${state.globalStatus}; ${state.dominantActivity}`);
    const status = this.root.querySelector('[data-office-status]');
    if (status) status.textContent = `${state.globalStatus} · ${state.dominantActivity}`;
    const visible = new Set<string>();
    const allActors = state.leader ? [state.leader, ...state.actors] : state.actors;
    for (const actor of allActors) {
      visible.add(actor.id);
      this.actorState.set(actor.id, actor);
      const node = this.ensureActor(actor);
      this.updateActor(node, actor);
      const zone = this.root.querySelector(`[data-office-zone="${actor.zone}"] [data-zone-actors]`);
      if (zone && node.parentElement !== zone) zone.appendChild(node);
    }
    for (const [id, node] of this.actors) {
      if (visible.has(id)) continue;
      node.remove();
      this.actors.delete(id);
      this.actorState.delete(id);
    }
    this.renderNotifications(state);
    this.renderActivityList(state);
    if (this.selectedActorId && !this.actorState.has(this.selectedActorId)) this.selectedActorId = '';
    this.renderInspector();
    this.enqueue(transitions);
  }

  clear(): void {
    for (const node of this.actors.values()) node.remove();
    this.actors.clear();
    this.actorState.clear();
    this.selectedActorId = '';
    const status = this.root.querySelector('[data-office-status]');
    if (status) status.textContent = 'idle';
    this.renderInspector();
  }

  private ensureActor(actor: PixelActorState): HTMLButtonElement {
    const existing = this.actors.get(actor.id);
    if (existing) return existing;
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'pixel-actor';
    node.dataset.officeActor = actor.id;
    node.innerHTML = '<span class="pixel-avatar" aria-hidden="true"><i class="pixel-hair"></i><i class="pixel-face"></i><i class="pixel-body"></i></span><span class="pixel-actor-copy"><strong></strong><small></small><em></em></span>';
    this.actors.set(actor.id, node);
    return node;
  }

  private updateActor(node: HTMLButtonElement, actor: PixelActorState): void {
    node.dataset.activity = actor.activity;
    node.dataset.pose = actor.pose;
    node.dataset.status = actor.status || '';
    node.style.setProperty('--actor-hue', String(hueFor(actor.agentId)));
    node.setAttribute('aria-label', `${actor.name}, ${actor.role}, ${actor.activity}${actor.taskLabel ? `, ${actor.taskLabel}` : ''}`);
    const title = node.querySelector('strong');
    const detail = node.querySelector('small');
    const badge = node.querySelector('em');
    if (title) title.textContent = actor.name;
    if (detail) detail.textContent = actor.taskLabel || `${actor.role}${actor.model ? ` · ${actor.model}` : ''}`;
    if (badge) badge.textContent = actor.verdict
      ? actor.verdict.toUpperCase()
      : actor.reworkCycle ? `R${actor.reworkCycle}` : actor.progressPercent != null ? `${actor.progressPercent}%` : actor.activity;
  }

  private renderNotifications(state: PixelOfficeSceneState): void {
    const host = this.root.querySelector('[data-office-notifications]');
    if (!host) return;
    host.replaceChildren(...state.notifications.map(notification => {
      const item = textElement('span', `office-notification is-${notification.kind}`, `${notification.label}: ${notification.count}`);
      item.setAttribute('role', 'status');
      return item;
    }));
  }

  private renderActivityList(state: PixelOfficeSceneState): void {
    const host = this.root.querySelector('[data-office-activity-list]');
    if (!host) return;
    host.replaceChildren(...state.activities.map(activity => textElement('li', `is-${activity.activity}`, activity.label)));
  }

  private renderInspector(): void {
    const host = this.root.querySelector('[data-office-inspector]');
    if (!host) return;
    const actor = this.actorState.get(this.selectedActorId);
    if (!actor) {
      host.replaceChildren(textElement('div', 'muted', 'Select an agent or desk to inspect its run.'));
      return;
    }
    const heading = textElement('div', 'office-inspector-title', actor.name);
    const meta = textElement('div', 'meta', [actor.role, actor.model, actor.status, actor.activity].filter(Boolean).join(' · '));
    const task = textElement('div', 'office-inspector-task', actor.taskLabel || 'No task label');
    const progress = textElement('div', 'meta', actor.progressNote || (actor.progressPercent != null ? `Progress: ${actor.progressPercent}%` : 'No progress note'));
    const runDetails = actor.run ? textElement('div', 'meta', [
      actor.runId ? `Run ${actor.runId}` : '',
      actor.origin ? `origin ${actor.origin}` : '',
      actor.run.phase ? `phase ${actor.run.phase}` : '',
      actor.verdict ? `review ${actor.verdict}` : '',
      actor.run.startedAt ? `started ${actor.run.startedAt}` : '',
      actor.run.endedAt ? `ended ${actor.run.endedAt}` : '',
    ].filter(Boolean).join(' · ')) : null;
    const logTail = actor.run?.logTail ? textElement('pre', 'run-card-log office-inspector-log', actor.run.logTail) : null;
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    if (actor.runId) {
      if (actor.status === 'starting' || actor.status === 'running' || actor.status === 'waiting') {
        const stop = textElement('button', 'ghost run-stop', 'Stop') as HTMLButtonElement;
        stop.type = 'button';
        stop.dataset.runId = actor.runId;
        actions.append(stop);
        const model = textElement('button', 'ghost run-set-model', 'Model…') as HTMLButtonElement;
        model.type = 'button';
        model.dataset.runId = actor.runId;
        actions.append(model);
      }
      const log = textElement('button', 'ghost run-log', 'Full log') as HTMLButtonElement;
      log.type = 'button';
      log.dataset.runId = actor.runId;
      actions.append(log);
    }
    host.replaceChildren(heading, meta, task, progress, ...(runDetails ? [runDetails] : []), ...(logTail ? [logTail] : []), actions);
  }

  private enqueue(items: PixelTransition[]): void {
    for (const item of items) {
      if (this.played.has(item.key) || this.transitions.some(queued => queued.key === item.key)) continue;
      this.transitions.push(item);
    }
    if (this.transitions.length > MAX_QUEUED_TRANSITIONS) {
      const critical = this.transitions.filter(item => item.critical);
      const cosmetic = this.transitions.filter(item => !item.critical);
      this.transitions = [...critical, ...cosmetic].slice(-MAX_QUEUED_TRANSITIONS);
    }
    void this.playNext();
  }

  private async playNext(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    while (this.transitions.length) {
      const transition = this.transitions.shift()!;
      this.played.add(transition.key);
      this.root.dataset.transition = transition.type.toLowerCase();
      const ticker = this.root.querySelector('[data-office-transition]');
      if (ticker) ticker.textContent = transition.label;
      const actor = transition.actorId ? this.actors.get(transition.actorId) : null;
      actor?.classList.add('is-transitioning');
      const reduced = this.root.classList.contains('reduced-effects') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      await new Promise(resolve => window.setTimeout(resolve, reduced ? 20 : 360));
      actor?.classList.remove('is-transitioning');
    }
    delete this.root.dataset.transition;
    this.playing = false;
  }
}
