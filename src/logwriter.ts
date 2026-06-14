/**
 * logwriter.ts — Écriture des journaux d'actions Web DMP.
 *
 * Pour chaque session d'enregistrement, on produit DEUX fichiers dans
 *   <userData>/dmp_logs/ :
 *
 *   1. session_<id>.jsonl   — une ligne JSON par action (format machine,
 *                             destiné à générer le futur scénario de rejeu)
 *   2. session_<id>.log     — version lisible par un humain (pour qu'on relise
 *                             ensemble ce qui a été fait, sans parser de JSON)
 *
 * Un fichier index.jsonl récapitule toutes les sessions (début, fin, nb actions,
 * patient concerné), pour retrouver facilement un enregistrement.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RecorderEvent {
  session: string;
  seq: number;
  t: number;                 // epoch ms
  kind: string;              // click | input | change | focus | blur | submit | key | dom-appear | navigate | ...
  url?: string;
  pageTitle?: string;
  target?: Record<string, unknown> | null;
  value?: unknown;
  sensitive?: boolean;
  [k: string]: unknown;
}

export class DmpLogSession {
  readonly id: string;
  readonly dir: string;
  readonly jsonlPath: string;
  readonly logPath: string;
  private count = 0;
  private readonly startedAt: number;
  private patientLabel: string;
  private closed = false;

  constructor(logsDir: string, patientLabel: string) {
    this.startedAt = Date.now();
    this.patientLabel = patientLabel || '(patient non précisé)';
    this.id = DmpLogSession.makeId(this.startedAt);
    this.dir = logsDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.jsonlPath = path.join(this.dir, `session_${this.id}.jsonl`);
    this.logPath   = path.join(this.dir, `session_${this.id}.log`);

    const header =
      `╔══════════════════════════════════════════════════════════════════╗\n` +
      `║  WebDMP Assistant — Journal d'actions Web DMP                      ║\n` +
      `╚══════════════════════════════════════════════════════════════════╝\n` +
      `Session    : ${this.id}\n` +
      `Patient    : ${this.patientLabel}\n` +
      `Début      : ${new Date(this.startedAt).toLocaleString('fr-FR')}\n` +
      `Fichier brut (rejeu) : ${path.basename(this.jsonlPath)}\n` +
      `${'─'.repeat(72)}\n\n`;
    fs.writeFileSync(this.logPath, header, 'utf-8');
    fs.writeFileSync(this.jsonlPath, '', 'utf-8');
  }

  private static makeId(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_`
         + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** Écrit une action dans les deux fichiers. Robuste : n'émet jamais d'exception. */
  write(ev: RecorderEvent): void {
    if (this.closed) return;
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(ev) + '\n', 'utf-8');
      fs.appendFileSync(this.logPath, this.humanize(ev) + '\n', 'utf-8');
      this.count++;
    } catch { /* ne pas interrompre l'enregistrement pour une erreur disque */ }
  }

  /** Met à jour le patient si on le détecte après le démarrage. */
  setPatient(label: string): void {
    if (label) this.patientLabel = label;
  }

  /** Transforme une action en ligne lisible par un humain. */
  private humanize(ev: RecorderEvent): string {
    const ms = ev.t - this.startedAt;
    const secs = (ms / 1000).toFixed(1).padStart(6, ' ');
    const tgt = (ev.target || {}) as Record<string, unknown>;

    const name = () => {
      const label = tgt.label || tgt.ariaLabel || tgt.text || tgt.placeholder
                 || tgt.name || tgt.id || tgt.dataTestId;
      const tag = tgt.tag ? String(tgt.tag) : '?';
      const typ = tgt.type ? `:${tgt.type}` : '';
      return label ? `«${String(label).slice(0, 60)}» [${tag}${typ}]`
                   : `[${tag}${typ}]`;
    };

    const valueStr = () => {
      if (ev.sensitive && ev.value && typeof ev.value === 'object') {
        const len = (ev.value as { length?: number }).length ?? '?';
        return ` = ●●●●● (masqué, ${len} car.)`;
      }
      if (ev.value === undefined || ev.value === null || ev.value === '') return '';
      if (typeof ev.value === 'object') return ' = ' + JSON.stringify(ev.value);
      return ` = "${String(ev.value).slice(0, 80)}"`;
    };

    let line: string;
    switch (ev.kind) {
      case 'recorder-ready':
        line = `▶  Enregistrement actif sur la page`;
        break;
      case 'navigate':
        line = `🌐 Navigation → ${ev.url}`;
        break;
      case 'click':
        line = `🖱  Clic ${name()}`;
        break;
      case 'input':
        line = `⌨  Saisie ${name()}${valueStr()}`;
        break;
      case 'change':
        if (ev.selectedText) line = `▼  Choix ${name()} → "${String(ev.selectedText).slice(0,60)}"`;
        else if (ev.files)   line = `📎 Fichier(s) ${name()} → ${JSON.stringify(ev.files)}`;
        else if (ev.checked !== undefined) line = `☑  Coche ${name()} → ${ev.checked}`;
        else line = `✎  Modif ${name()}${valueStr()}`;
        break;
      case 'focus':  line = `   ·  focus ${name()}`; break;
      case 'blur':   line = `   ·  quitte ${name()}`; break;
      case 'submit': line = `📤 Soumission formulaire ${name()}`; break;
      case 'key':    line = `⏎  Touche ${ev.key} sur ${name()}`; break;
      case 'dom-appear': line = `✨ Apparition : ${name()} (${ev.info || ''})`; break;
      default:       line = `${ev.kind} ${name()}${valueStr()}`;
    }

    // Pour les actions clés, on ajoute le sélecteur technique en sous-ligne
    const technical = ['click', 'change', 'submit', 'input'].includes(ev.kind);
    let extra = '';
    if (technical && (tgt.css || tgt.xpath)) {
      extra = `\n         ↳ css: ${tgt.css || '—'}`;
      if (tgt.xpath) extra += `\n         ↳ xpath: ${tgt.xpath}`;
    }

    return `[+${secs}s] #${String(ev.seq).padStart(4, '0')}  ${line}${extra}`;
  }

  /** Clôt la session : pied de page lisible + entrée dans l'index. */
  close(indexPath: string): { id: string; count: number; jsonl: string; log: string } {
    if (this.closed) return { id: this.id, count: this.count, jsonl: this.jsonlPath, log: this.logPath };
    this.closed = true;
    const endedAt = Date.now();
    const footer =
      `\n${'─'.repeat(72)}\n` +
      `Fin        : ${new Date(endedAt).toLocaleString('fr-FR')}\n` +
      `Durée      : ${((endedAt - this.startedAt) / 1000).toFixed(1)} s\n` +
      `Actions    : ${this.count}\n`;
    try { fs.appendFileSync(this.logPath, footer, 'utf-8'); } catch {}

    try {
      const entry = {
        id: this.id,
        patient: this.patientLabel,
        started: this.startedAt,
        ended: endedAt,
        actions: this.count,
        jsonl: path.basename(this.jsonlPath),
        log: path.basename(this.logPath),
      };
      fs.appendFileSync(indexPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {}

    return { id: this.id, count: this.count, jsonl: this.jsonlPath, log: this.logPath };
  }

  get actionCount(): number { return this.count; }
}
