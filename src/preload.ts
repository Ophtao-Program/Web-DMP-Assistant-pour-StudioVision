/**
 * preload.ts — Bridge sécurisé entre main et renderer
 * Expose uniquement les APIs nécessaires via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dmpAPI', {

  /** Lit le patient actuellement ouvert dans StudioVision via COM */
  getActivePatient: () =>
    ipcRenderer.invoke('get-active-patient'),

  /** Infos administratives d'un patient (nom, prénom, DDN, SS/INS) */
  getPatientInfo: (code: string) =>
    ipcRenderer.invoke('get-patient-info', code),

  /** Liste les derniers documents PDF/images du patient depuis la base Access */
  getPatientDocuments: (code: string) =>
    ipcRenderer.invoke('get-patient-documents', code),

  /** Lit les dernières notes/observations du patient */
  getPatientNotes: (code: string) =>
    ipcRenderer.invoke('get-patient-notes', code),

  /** Ouvre (ou focus) la fenêtre Web DMP — va directement sur Pro Santé Connect et pré-remplit l'identifiant */
  openDmpWindow: (ecpsId: string) =>
    ipcRenderer.invoke('open-dmp-window', ecpsId),

  /** Ferme la fenêtre Web DMP */
  closeDmpWindow: () =>
    ipcRenderer.invoke('close-dmp-window'),

  /** Copie un texte dans le presse-papier */
  copyToClipboard: (text: string) =>
    ipcRenderer.invoke('copy-to-clipboard', text),

  /** Ouvre un fichier document dans l'application par défaut */
  openDocument: (chemin: string) =>
    ipcRenderer.invoke('open-document', chemin),

  /** Guide d'utilisation */
  ouvrirGuide: () =>
    ipcRenderer.invoke('ouvrir-guide'),

  /** Sauvegarde la configuration locale */
  saveConfig: (config: Record<string, unknown>) =>
    ipcRenderer.invoke('save-config', config),

  /** Charge la configuration locale */
  loadConfig: () =>
    ipcRenderer.invoke('load-config'),

  /** Reçoit les événements de navigation depuis la fenêtre DMP */
  onDmpUrlChanged: (cb: (url: string) => void) => {
    ipcRenderer.on('dmp-url-changed', (_event, url) => cb(url));
  },

  /** Notifie quand la fenêtre DMP est fermée */
  onDmpWindowClosed: (cb: () => void) => {
    ipcRenderer.on('dmp-window-closed', () => cb());
  },

  // ── Enregistreur d'actions Web DMP ──────────────────────────────────────
  /** Démarre l'enregistrement des actions (patientLabel = en-tête du journal) */
  recorderStart: (patientLabel: string) =>
    ipcRenderer.invoke('recorder-start', patientLabel),

  /** Arrête l'enregistrement et renvoie le récapitulatif */
  recorderStop: () =>
    ipcRenderer.invoke('recorder-stop'),

  /** État courant de l'enregistreur */
  recorderStatus: () =>
    ipcRenderer.invoke('recorder-status'),

  /** Ouvre le dossier des journaux dans l'explorateur */
  openLogsFolder: () =>
    ipcRenderer.invoke('open-logs-folder'),

  /** Liste les sessions déjà enregistrées */
  listRecordings: () =>
    ipcRenderer.invoke('list-recordings'),

  /** Flux live des actions capturées (compteur + type) */
  onRecorderEvent: (cb: (info: { seq: number; kind: string; count: number }) => void) => {
    ipcRenderer.on('recorder-event', (_event, info) => cb(info));
  },

  // ── Dépôt automatique sur le DMP ────────────────────────────────────────
  /** Lance le dépôt automatique d'un document (ouvre le DMP, attend e-CPS, automatise la suite) */
  dmpDeposit: (opts: Record<string, unknown>) =>
    ipcRenderer.invoke('dmp-deposit', opts),

  /** Lit les types de documents proposés par le portail (page d'ajout ouverte) */
  readDocTypes: () =>
    ipcRenderer.invoke('dmp-read-doctypes'),

  /** Progression du dépôt automatique, étape par étape */
  onDepositProgress: (cb: (info: { step: string; status: string; detail?: string }) => void) => {
    ipcRenderer.on('deposit-progress', (_event, info) => cb(info));
  },

});
