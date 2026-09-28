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
      if (actor) {
        const actorId = actor.dataset.officeActor || '';
        this.selectedActorId = this.selectedActorId === actorId ? '' : actorId;
        this.renderThoughtCloud();
        return;
      }
      if (!(event.target as Element | null)?.closest?.('[data-office-thought-cloud]')) {
        this.selectedActorId = '';
        this.renderThoughtCloud();
      }
    });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.selectedActorId) return;
      this.selectedActorId = '';
      this.renderThoughtCloud();
    });
    window.addEventListener('resize', () => this.positionThoughtCloud());
  }

  apply(state: PixelOfficeSceneState, transitions: PixelTransition[]): void {
    const previousPositions = new Map<string, DOMRect>();
    for (const [id, node] of this.actors) previousPositions.set(id, node.getBoundingClientRect());
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
    this.animateActorMoves(previousPositions);
    this.renderNotifications(state);
    if (this.selectedActorId && !this.actorState.has(this.selectedActorId)) this.selectedActorId = '';
    this.renderThoughtCloud();
    this.enqueue(transitions);
  }

  clear(): void {
    for (const node of this.actors.values()) node.remove();
    this.actors.clear();
    this.actorState.clear();
    this.selectedActorId = '';
    const status = this.root.querySelector('[data-office-status]');
    if (status) status.textContent = 'idle';
    this.renderThoughtCloud();
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
    node.classList.toggle('is-selected', actor.id === this.selectedActorId);
    node.setAttribute('aria-expanded', String(actor.id === this.selectedActorId));
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

  private renderThoughtCloud(): void {
    const host = this.root.querySelector<HTMLElement>('[data-office-thought-cloud]');
    if (!host) return;
    const actor = this.actorState.get(this.selectedActorId);
    if (!actor) {
      host.hidden = true;
      host.replaceChildren();
      for (const node of this.actors.values()) {
        node.classList.remove('is-selected');
        node.setAttribute('aria-expanded', 'false');
      }
      return;
    }
    const heading = textElement('div', 'office-thought-cloud-header', actor.name);
    const meta = textElement('div', 'office-thought-cloud-meta', [actor.role, actor.provider, actor.model, actor.reasoningEffort && `reasoning ${actor.reasoningEffort}`, actor.mode, actor.status, actor.activity].filter(Boolean).join(' · '));
    const task = textElement('div', 'office-thought-cloud-task', actor.taskLabel || 'No task label');
    const progress = textElement('div', 'office-thought-cloud-meta', actor.progressNote || (actor.progressPercent != null ? `Progress: ${actor.progressPercent}%` : 'No progress note'));
    const runDetails = actor.run ? textElement('div', 'meta', [
      actor.runId ? `Run ${actor.runId}` : '',
      actor.origin ? `origin ${actor.origin}` : '',
      actor.run.phase ? `phase ${actor.run.phase}` : '',
      actor.verdict ? `review ${actor.verdict}` : '',
      actor.run.startedAt ? `started ${actor.run.startedAt}` : '',
      actor.run.endedAt ? `ended ${actor.run.endedAt}` : '',
    ].filter(Boolean).join(' · ')) : null;
    const active = actor.status === 'starting' || actor.status === 'running' || actor.status === 'waiting';
    const logTail = actor.run ? textElement('pre', 'office-thought-cloud-log', actor.run.logTail || (active ? 'Waiting for output…' : 'Finished — open Full log to read it.')) : null;
    const actions = document.createElement('div');
    actions.className = 'office-thought-cloud-actions';
    if (actor.runId) {
      if (active) {
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
    host.hidden = false;
    for (const [id, node] of this.actors) {
      node.classList.toggle('is-selected', id === actor.id);
      node.setAttribute('aria-expanded', String(id === actor.id));
    }
    this.positionThoughtCloud();
  }

  private positionThoughtCloud(): void {
    const host = this.root.querySelector<HTMLElement>('[data-office-thought-cloud]');
    const actor = this.actors.get(this.selectedActorId);
    if (!host || host.hidden || !actor) return;
    const rootRect = this.root.getBoundingClientRect();
    const actorRect = actor.getBoundingClientRect();
    const cloudRect = host.getBoundingClientRect();
    const margin = 20;
    let side = 'top-right';
    let left = actorRect.right - rootRect.left + 8;
    let top = actorRect.top - rootRect.top - cloudRect.height - 12;
    if (left + cloudRect.width > rootRect.width - margin) {
      left = actorRect.left - rootRect.left - cloudRect.width - 8;
      side = 'top-left';
    }
    if (top < margin) {
      top = actorRect.bottom - rootRect.top + 12;
      side = side === 'top-left' ? 'bottom-left' : 'bottom-right';
    }
    left = Math.max(margin, Math.min(left, rootRect.width - cloudRect.width - margin));
    top = Math.max(margin, Math.min(top, rootRect.height - cloudRect.height - margin));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.dataset.cloudSide = side;
  }

  private animateActorMoves(previousPositions: Map<string, DOMRect>): void {
    const reduced = this.root.classList.contains('reduced-effects') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    for (const [id, before] of previousPositions) {
      const node = this.actors.get(id);
      if (!node || !node.isConnected) continue;
      const after = node.getBoundingClientRect();
      const deltaX = before.left - after.left;
      const deltaY = before.top - after.top;
      if (Math.abs(deltaX) < 2 && Math.abs(deltaY) < 2) continue;
      node.animate([
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ], { duration: 620, easing: 'steps(8, end)' });
    }
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
      const effect = this.createEffect(transition);
      await new Promise(resolve => window.setTimeout(resolve, reduced ? 20 : 560));
      actor?.classList.remove('is-transitioning');
      effect?.remove();
    }
    delete this.root.dataset.transition;
    this.playing = false;
  }

  private createEffect(transition: PixelTransition): HTMLElement | null {
    const icons: Record<string, string> = {
      DISPATCH: '▣',
      REVIEW_HANDOFF: '➜ REVIEW',
      REWORK_RETURN: '↶ REWORK',
      VERDICT_PASS: '✓ PASS',
      VERDICT_REWORK: '↶ REWORK',
      VERDICT_BLOCK: '! BLOCK',
      REPORTING: '▤ REPORT',
      EXTERNAL_ARRIVAL: '↳ VISITOR',
      STATUS_DONE: '★ DONE',
      STATUS_FAILED: '! FAILED',
    };
    const icon = icons[transition.type];
    if (!icon) return null;
    const effect = textElement('div', `office-effect is-${transition.type.toLowerCase()}`, icon);
    effect.setAttribute('aria-label', transition.label);
    this.root.append(effect);
    return effect;
  }
}
