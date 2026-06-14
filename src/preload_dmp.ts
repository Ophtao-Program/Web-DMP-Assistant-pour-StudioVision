/**
 * preload_dmp.ts — Preload dédié à la fenêtre Web DMP.
 *
 * Il expose dans la page DMP une fonction globale window.__dmpRecorderSink(ev)
 * que le script recorder appelle pour chaque action. Cette fonction transmet
 * l'événement au processus principal via IPC, où il sera journalisé.
 *
 * On garde contextIsolation actif ici (plus sûr) tout en exposant le strict
 * minimum : une seule fonction, à sens unique (renderer → main).
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__dmpRecorderSink', (ev: unknown) => {
  try {
    ipcRenderer.send('dmp-recorder-event', ev);
  } catch {
    /* ne jamais perturber la page DMP */
  }
});
