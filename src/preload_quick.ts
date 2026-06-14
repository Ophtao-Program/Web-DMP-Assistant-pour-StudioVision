/**
 * preload_quick.ts — Preload de la fenêtre de validation rapide (Ctrl+Alt+D).
 * Expose un pont minimal : réception du document à déposer, envoi, progression, annulation.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('quickApi', {
  onInit: (cb: (doc: unknown) => void) =>
    ipcRenderer.on('quick-deposit-init', (_e, doc) => cb(doc)),
  onProgress: (cb: (info: unknown) => void) =>
    ipcRenderer.on('deposit-progress', (_e, info) => cb(info)),
  send: (opts: Record<string, unknown>) =>
    ipcRenderer.invoke('quick-deposit-send', opts),
  cancel: () =>
    ipcRenderer.send('quick-deposit-cancel'),
});
