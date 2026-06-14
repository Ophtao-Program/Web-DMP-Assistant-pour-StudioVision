/**
 * main.ts — Processus principal Electron
 * WebDMP Assistant — dépôt automatisé de documents dans Mon Espace Santé
 */

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard,
         Tray, Menu, globalShortcut, nativeImage } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { buildRecorderScript } from './recorder';
import { DmpLogSession, RecorderEvent } from './logwriter';
import { runDeposit, readDocTypes, preflight, DepositOptions } from './replay';
import { buildDocTypeOptionsHtml } from './doctypes';

const PYTHON_SCRIPT = path.join(__dirname, '..', 'python', 'dmp_connector.py');

// Mode service : lancé par Se-Connecter-WebDMP.bat (--service). Réside en fond,
// icône près de l'horloge, raccourci global Ctrl+Alt+D pour envoyer le document
// sélectionné dans StudioVision.
const SERVICE_MODE = process.argv.includes('--service');
const HOTKEY = 'CommandOrControl+Alt+D';
let tray: Tray | null = null;
let quickWindow: BrowserWindow | null = null;
let savedEcpsId = '';   // identifiant e-CPS mémorisé (config) pour le mode service

let mainWindow: BrowserWindow | null = null;
let dmpWindow:  BrowserWindow | null = null;
let dmpAuthenticated = false;   // vrai dès qu'une session DMP a été ouverte (évite de relancer OIDC)

// ── État de l'enregistreur d'actions ─────────────────────────────────────────
const LOGS_DIR   = path.join(app.getPath('userData'), 'dmp_logs');
const LOGS_INDEX = path.join(LOGS_DIR, 'index.jsonl');
let logSession: DmpLogSession | null = null;     // session d'enregistrement courante

/** Injecte le script recorder dans la fenêtre DMP (idempotent). */
function injectRecorder(): void {
  if (!logSession || !dmpWindow || dmpWindow.isDestroyed()) return;
  dmpWindow.webContents
    .executeJavaScript(buildRecorderScript(logSession.id))
    .catch(() => {});
}


// ── 1. FENÊTRE PRINCIPALE ────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width:           480,
    height:          820,
    minWidth:        440,
    minHeight:       600,
    title:           'WebDMP Assistant',
    resizable:       true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}


// ── 2. FENÊTRE WEB DMP ───────────────────────────────────────────────────────

function createDmpWindow(visible: boolean = true): BrowserWindow {
  const win = new BrowserWindow({
    width:  1280,
    height: 900,
    title:  'Web DMP — Mon Espace Santé',
    show:   visible,                 // masquée en mode tâche de fond
    webPreferences: {
      preload:             path.join(__dirname, 'preload_dmp.js'),
      contextIsolation:    true,
      nodeIntegration:     false,
      backgroundThrottling: false,   // garder la page active même fenêtre masquée
      // Session persistante : garde la connexion CPS/e-CPS entre sessions
      session: require('electron').session.fromPartition('persist:webdmp'),
    },
  });

  win.on('closed', () => {
    dmpWindow = null;
    // Notifier la fenêtre principale que la fenêtre DMP a été fermée
    mainWindow?.webContents.send('dmp-window-closed');
  });

  win.webContents.on('did-navigate', (_event, url) => {
    mainWindow?.webContents.send('dmp-url-changed', url);
    if (/\/mespatients/.test(url) || /\/dmp\//.test(url)) dmpAuthenticated = true;
    if (logSession) {
      logSession.write({ session: logSession.id, seq: 0, t: Date.now(),
                         kind: 'navigate', url } as RecorderEvent);
    }
  });

  win.webContents.on('did-navigate-in-page', (_event, url) => {
    mainWindow?.webContents.send('dmp-url-changed', url);
  });

  // À chaque page chargée, si un enregistrement est actif, (ré)injecter le recorder
  win.webContents.on('did-finish-load', () => {
    if (logSession) injectRecorder();
  });

  return win;
}


// ── 3. APPEL PYTHON ──────────────────────────────────────────────────────────

function runPython(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const py = spawn('python', [PYTHON_SCRIPT, ...args], {
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d: Buffer) => stdout += d.toString());
    py.stderr.on('data', (d: Buffer) => {
      const line = d.toString();
      stderr += line;
      process.stdout.write('[Python] ' + line);
    });

    py.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`Python error (code ${code}):\n${stderr}`));
        return;
      }
      const braceIdx = stdout.indexOf('{');
      const brackIdx = stdout.indexOf('[');
      const jsonStart = (braceIdx === -1) ? brackIdx
                      : (brackIdx === -1) ? braceIdx
                      : Math.min(braceIdx, brackIdx);
      if (jsonStart === -1) {
        // Pas de JSON → retourner objet vide sans erreur
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdout.slice(jsonStart)));
      } catch {
        reject(new Error(`JSON parse error:\n${stdout}`));
      }
    });
  });
}


// ── 4. IPC ───────────────────────────────────────────────────────────────────

/** Détection du patient actif dans StudioVision */
ipcMain.handle('get-active-patient', async () => {
  try {
    const result = await runPython(['--get-active-patient']) as Record<string, string | null>;
    return { success: true, patient: result };
  } catch (err) {
    return { success: false, patient: { code: null }, error: String(err) };
  }
});

/** Infos administratives d'un patient */
ipcMain.handle('get-patient-info', async (_event, code: string) => {
  try {
    const info = await runPython(['--get-info', code]);
    return { success: true, info };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

/** Liste des derniers documents du patient */
ipcMain.handle('get-patient-documents', async (_event, code: string) => {
  try {
    const docs = await runPython(['--get-documents', code]);
    return { success: true, docs };
  } catch (err) {
    return { success: false, docs: [], error: String(err) };
  }
});

/** Notes / observations du patient */
ipcMain.handle('get-patient-notes', async (_event, code: string) => {
  try {
    const notes = await runPython(['--get-notes', code]);
    return { success: true, notes };
  } catch (err) {
    return { success: false, notes: [], error: String(err) };
  }
});

/**
 * Ouvre (ou ramène au premier plan) la fenêtre Web DMP.
 * Va directement sur l'URL Pro Santé Connect et pré-remplit l'identifiant e-CPS.
 *
 * URL directe PSC (évite les deux clics "Accès DMP" → "PRO SANTÉ CONNECT") :
 *   https://wallet.esw.esante.gouv.fr/auth/?scope=openid%20scope_all&acr_values=eidas1
 *   &response_type=code&redirect_uri=https://wps-psc.dmp.monespacesante.fr/callbackoidc
 *   &client_id=cnam-webps-dmp
 *
 * Après chargement de la page PSC, on injecte l'identifiant dans le champ login
 * et on focus le bouton "SE CONNECTER AVEC E-CPS" pour que l'utilisateur n'ait
 * plus qu'à appuyer sur Entrée (ou cliquer), puis valider sur son mobile.
 */
const PSC_URL = 'https://wallet.esw.esante.gouv.fr/auth/'
  + '?scope=openid%20scope_all'
  + '&acr_values=eidas1'
  + '&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fwps-psc.dmp.monespacesante.fr%2Fcallbackoidc'
  + '&client_id=cnam-webps-dmp';

// Page d'accueil de l'application DMP. Si la session est déjà active, elle mène
// directement à « Mes Patients » SANS repasser par le tunnel OIDC (ce qui, sur une
// session active, provoque l'erreur "Erreur générale non identifiée" via callbackoidc).
const DMP_HOME = 'https://wps-psc.dmp.monespacesante.fr/';

// Script JS injecté dans la page PSC — remplit l'identifiant et clique automatiquement
function buildLoginScript(ecpsId: string): string {
  const safe = JSON.stringify(ecpsId);
  return `
(function() {
  var MAX_ATTEMPTS = 40;
  var attempt = 0;

  function tryFill() {
    attempt++;
    var selectors = [
      'input[name="login"]', 'input[id="login"]',
      'input[name="username"]', 'input[id="username"]',
      'input[autocomplete="username"]', 'input[type="text"]', 'input[type="email"]',
    ];
    var input = null;
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.offsetParent !== null) { input = el; break; }
    }
    if (!input) {
      if (attempt < MAX_ATTEMPTS) setTimeout(tryFill, 300);
      return;
    }
    // Remplir via le setter natif (compatible React/Angular)
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${safe});
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Cliquer automatiquement sur le bouton e-CPS après un court délai
    setTimeout(function() {
      var btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      var ecpsBtn = btns.find(function(b) {
        var t = (b.textContent || b.getAttribute('value') || '').toLowerCase();
        return t.includes('e-cps') || t.includes('ecps') || t.includes('pro sant');
      });
      if (ecpsBtn) {
        ecpsBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function() { ecpsBtn.click(); }, 300);
      } else {
        // Fallback : soumettre le formulaire directement
        var form = input.closest('form');
        var submitBtn = form && form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) { setTimeout(function() { submitBtn.click(); }, 300); }
      }
    }, 700);
  }
  tryFill();
})();
`;
}

/** Ouvre (ou ramène au premier plan) la fenêtre DMP et lance l'auth PSC/e-CPS. */
async function ensureDmpWindow(ecpsId: string, background: boolean = false): Promise<BrowserWindow> {
  if (!dmpWindow || dmpWindow.isDestroyed()) {
    dmpWindow = createDmpWindow(!background);   // masquée si tâche de fond
    // Si une session DMP a déjà été ouverte dans cette exécution, on va droit à
    // l'appli (réutilise la session) au lieu de relancer OIDC, ce qui éviterait
    // l'« Erreur générale non identifiée ». Sinon, tunnel OIDC normal.
    await dmpWindow.loadURL(dmpAuthenticated ? DMP_HOME : PSC_URL);

    // Injecter l'identifiant après chaque navigation vers la page PSC
    dmpWindow.webContents.on('did-finish-load', () => {
      const url = dmpWindow!.webContents.getURL();
      const isPscPage = url.includes('wallet.esw.esante.gouv.fr')
                     || url.includes('auth.esw.esante.gouv.fr');
      if (isPscPage && ecpsId) {
        dmpWindow!.webContents.executeJavaScript(buildLoginScript(ecpsId))
          .catch(() => {});
      }
      // Si un enregistrement est actif, (ré)injecter le recorder sur la nouvelle page
      if (logSession) injectRecorder();
      // Notifier le renderer de l'URL courante
      if (mainWindow) mainWindow.webContents.send('dmp-url-changed', url);
    });
  } else {
    const currentUrl = dmpWindow.webContents.getURL();
    const alreadyLoggedIn = currentUrl.includes('dmp.monespacesante.fr')
                         || currentUrl.includes('dmp.fr/ps');
    if (!alreadyLoggedIn) {
      await dmpWindow.loadURL(PSC_URL);
    }
    if (!background) dmpWindow.focus();   // en tâche de fond, rester masquée
  }
  return dmpWindow;
}

ipcMain.handle('open-dmp-window', async (_event, ecpsId: string) => {
  await ensureDmpWindow(ecpsId);
  return { success: true };
});

/** Ferme la fenêtre DMP */
ipcMain.handle('close-dmp-window', () => {
  if (dmpWindow && !dmpWindow.isDestroyed()) {
    dmpWindow.close();
  }
  return { success: true };
});


// ── 4bis. ENREGISTREUR D'ACTIONS WEB DMP ─────────────────────────────────────

/** Réception d'un événement émis par le recorder injecté dans la page DMP. */
ipcMain.on('dmp-recorder-event', (_event, ev: RecorderEvent) => {
  if (!logSession) return;
  try {
    logSession.write(ev);
    // Retour live vers la fenêtre principale (compteur + dernière action)
    mainWindow?.webContents.send('recorder-event', {
      seq: ev.seq, kind: ev.kind,
      count: logSession.actionCount,
    });
  } catch { /* ignore */ }
});

/**
 * Démarre une session d'enregistrement.
 * patientLabel : ex. "MEGRET Leo (5182)" — sert d'en-tête de log.
 */
ipcMain.handle('recorder-start', (_event, patientLabel: string) => {
  try {
    if (logSession) {
      // déjà en cours : on clôt proprement la précédente avant d'en ouvrir une neuve
      logSession.close(LOGS_INDEX);
    }
    logSession = new DmpLogSession(LOGS_DIR, patientLabel || '');
    injectRecorder();   // si la fenêtre DMP est déjà ouverte
    return { success: true, sessionId: logSession.id,
             logFile: logSession.logPath, jsonlFile: logSession.jsonlPath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

/** Arrête l'enregistrement et renvoie le récapitulatif + chemins de fichiers. */
ipcMain.handle('recorder-stop', () => {
  if (!logSession) return { success: false, error: 'Aucun enregistrement en cours.' };
  const res = logSession.close(LOGS_INDEX);
  logSession = null;
  return { success: true, ...res };
});

/** Indique si un enregistrement est actif (pour resynchroniser l'UI). */
ipcMain.handle('recorder-status', () => {
  return logSession
    ? { recording: true, sessionId: logSession.id, count: logSession.actionCount }
    : { recording: false };
});

/** Ouvre le dossier des journaux dans l'explorateur. */
ipcMain.handle('open-logs-folder', () => {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    shell.openPath(LOGS_DIR);
    return { success: true, path: LOGS_DIR };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

/** Liste les sessions enregistrées (lecture de l'index). */
ipcMain.handle('list-recordings', () => {
  try {
    if (!fs.existsSync(LOGS_INDEX)) return { success: true, sessions: [] };
    const lines = fs.readFileSync(LOGS_INDEX, 'utf-8').trim().split('\n').filter(Boolean);
    const sessions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
                          .filter(Boolean)
                          .reverse();   // plus récentes d'abord
    return { success: true, sessions };
  } catch (err) {
    return { success: false, sessions: [], error: String(err) };
  }
});


// ── 4ter. DÉPÔT AUTOMATIQUE SUR LE DMP (moteur de rejeu) ─────────────────────

let depositRunning = false;

/**
 * Lance le dépôt automatique d'un document.
 * Ouvre la fenêtre DMP (auth e-CPS), attend la validation mobile, puis automatise
 * toute la suite. La progression est renvoyée au renderer via 'deposit-progress'.
 */
ipcMain.handle('dmp-deposit', async (_event, opts: DepositOptions & { ecpsId?: string }) => {
  if (depositRunning) return { ok: false, error: 'Un dépôt est déjà en cours.' };

  // Contrôle préalable avant même d'ouvrir le DMP
  const pf = preflight(opts);
  if (!pf.ok) return { ok: false, error: pf.reason };

  depositRunning = true;
  const emit = (info: { step: string; status: string; detail?: string }) =>
    mainWindow?.webContents.send('deposit-progress', info);
  try {
    const win = await ensureDmpWindow(opts.ecpsId || '', !!opts.background);
    const res = await runDeposit(win, opts, emit as any);
    return res;
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    depositRunning = false;
  }
});

/** Lit la liste des types de documents proposés par le portail (si page d'ajout ouverte). */
ipcMain.handle('dmp-read-doctypes', async () => {
  if (!dmpWindow || dmpWindow.isDestroyed())
    return { success: false, types: [], error: 'Fenêtre DMP non ouverte.' };
  const types = await readDocTypes(dmpWindow);
  return { success: true, types };
});

/**
 * Copie le texte d'une note dans le presse-papier
 */
ipcMain.handle('copy-to-clipboard', (_event, text: string) => {
  clipboard.writeText(text);
  return { success: true };
});

/**
 * Ouvre un document (PDF/image) dans l'application par défaut du système
 */
ipcMain.handle('open-document', (_event, cheminPhysique: string) => {
  shell.openPath(cheminPhysique);
  return { success: true };
});

/**
 * Ouvre le guide utilisateur
 */
ipcMain.handle('ouvrir-guide', () => {
  const guidePath = path.join(__dirname, '..', 'src', 'renderer', 'guide_dmp.html');
  if (fs.existsSync(guidePath)) {
    shell.openPath(guidePath);
  }
  return { success: true };
});

/**
 * Sauvegarde la configuration (identifiant e-CPS, etc.)
 */
const CONFIG_PATH = path.join(app.getPath('userData'), 'webdmp_config.json');

ipcMain.handle('save-config', (_event, config: Record<string, unknown>) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('load-config', () => {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { success: true, config: {} };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { success: true, config: JSON.parse(raw) };
  } catch (err) {
    return { success: false, config: {}, error: String(err) };
  }
});


// ── 4quater. MODE SERVICE (Ctrl+Alt+D depuis StudioVision) ───────────────────

/** Notification système discrète (icône près de l'horloge). */
function notify(title: string, body: string): void {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* ignore */ }
}

/** Icône de la zone de notification : fichier PNG fourni, sinon point bleu en dur. */
function makeTrayIcon(): Electron.NativeImage {
  try {
    const p = path.join(__dirname, '..', 'assets', 'tray.png');
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  } catch { /* ignore */ }
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfElEQVR4nGNgGAWjYBSMglEwCkbB' +
    'KBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNg' +
    'FIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIwCAEhfA9n7l0gAAAAAAElF' +
    'TkSuQmCC';
  return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
}

function setupTray(): void {
  if (tray) return;
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('WebDMP — service actif (Ctrl+Alt+D pour envoyer)');
  const menu = Menu.buildFromTemplate([
    { label: 'WebDMP Assistant — service actif', enabled: false },
    { type: 'separator' },
    { label: 'Envoyer le document sélectionné (Ctrl+Alt+D)', click: () => triggerQuickDeposit() },
    { label: 'Vérifier / rétablir la connexion e-CPS', click: () => ensureDmpWindow(savedEcpsId, false) },
    { label: 'Dossier des journaux', click: () => { fs.mkdirSync(LOGS_DIR, { recursive: true }); shell.openPath(LOGS_DIR); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => triggerQuickDeposit());
}

/** Résout le chemin physique d'un document à partir de son [Photo externe] relatif. */
function resolveDocPath(photoExterne: string): { filePath: string; fileName: string; existe: boolean } {
  const parts = photoExterne.split(/[/\\]/).filter(Boolean);
  const fileName = parts.length ? parts[parts.length - 1] : photoExterne;
  // DEST_PHOTOS est défini côté Python ; ici on lit la même racine via env ou défaut M:\PHOTOS
  const photosRoot = process.env.WEBDMP_PHOTOS || 'M:\\PHOTOS';
  let filePath = parts.length ? path.join(photosRoot, ...parts) : photoExterne;
  let existe = false;
  try { existe = fs.existsSync(filePath); } catch {}
  if (!existe) { try { if (fs.existsSync(photoExterne)) { filePath = photoExterne; existe = true; } } catch {} }
  return { filePath, fileName, existe };
}

let quickBusy = false;

/** Déclenché par Ctrl+Alt+D : lit le document sélectionné et ouvre la fenêtre de validation. */
async function triggerQuickDeposit(): Promise<void> {
  if (quickBusy) { quickWindow?.focus(); return; }
  if (quickWindow && !quickWindow.isDestroyed()) { quickWindow.focus(); return; }
  quickBusy = true;
  try {
    let sel: any;
    try {
      sel = await runPython(['--get-selected-document']);
    } catch (e) {
      notify('WebDMP', 'Impossible de lire StudioVision (Access ouvert ?).');
      return;
    }
    if (!sel || sel.selected === null || !sel.photo_externe) {
      notify('WebDMP', 'Aucun document sélectionné. Cliquez un document dans la fiche patient, puis Ctrl+Alt+D.');
      return;
    }

    const resolved = resolveDocPath(String(sel.photo_externe));
    const doc = {
      code: sel.code, nom: sel.nom, prenom: sel.prenom,
      photo_externe: sel.photo_externe, description: sel.description,
      date_str: sel.date_str, numdoc: sel.numdoc,
      type_dmp_suggere: sel.type_dmp_suggere,
      fileName: resolved.fileName, filePath: resolved.filePath, existe: resolved.existe,
      optionsHtml: buildDocTypeOptionsHtml(String(sel.type_dmp_suggere || '')),
    };

    quickWindow = new BrowserWindow({
      width: 460, height: 560, title: 'Envoyer au DMP',
      resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload_quick.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    quickWindow.removeMenu();
    quickWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'quick_deposit.html'));
    quickWindow.on('closed', () => { quickWindow = null; });
    quickWindow.webContents.once('did-finish-load', () => {
      quickWindow?.webContents.send('quick-deposit-init', doc);
    });
  } finally {
    quickBusy = false;
  }
}

/** Envoi depuis la fenêtre de validation rapide. */
ipcMain.handle('quick-deposit-send', async (_event, opts: DepositOptions & { ecpsId?: string }) => {
  if (depositRunning) return { ok: false, error: 'Un dépôt est déjà en cours.' };
  const pf = preflight(opts);
  if (!pf.ok) return { ok: false, error: pf.reason };

  depositRunning = true;
  const emit = (info: { step: string; status: string; detail?: string }) => {
    quickWindow?.webContents.send('deposit-progress', info);
  };
  try {
    const win = await ensureDmpWindow(savedEcpsId, true);   // tâche de fond
    const res = await runDeposit(win, opts, emit as any);
    if (res.ok) notify('WebDMP', `Document déposé : ${opts.fileName}`);
    return res;
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    depositRunning = false;
  }
});

ipcMain.on('quick-deposit-cancel', () => {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.close();
});

/** Charge l'identifiant e-CPS mémorisé (pour le mode service). */
function loadSavedEcpsId(): void {
  try {
    const p = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (cfg && typeof cfg.ecps_id === 'string') savedEcpsId = cfg.ecps_id;
    }
  } catch { /* ignore */ }
}

/** Démarre le mode service : auth initiale e-CPS, tray, raccourci global. */
async function startServiceMode(): Promise<void> {
  loadSavedEcpsId();
  setupTray();

  // Enregistrer le raccourci global Ctrl+Alt+D
  const ok = globalShortcut.register(HOTKEY, () => { triggerQuickDeposit(); });
  if (!ok) {
    notify('WebDMP', `Le raccourci ${HOTKEY} n'a pas pu être enregistré (déjà utilisé ?).`);
  }

  // Authentification initiale : on ouvre le DMP (visible) pour la validation e-CPS,
  // il se masquera une fois connecté. Ensuite, prêt pour les Ctrl+Alt+D.
  const win = await ensureDmpWindow(savedEcpsId, false);
  // Quand on atteint une page authentifiée, masquer la fenêtre : le service est prêt.
  const hideWhenReady = () => {
    const u = win.webContents.getURL();
    if (/\/mespatients/.test(u) || /\/dmp\//.test(u)) {
      win.hide();
      notify('WebDMP', 'Connecté. Sélectionnez un document dans StudioVision et faites Ctrl+Alt+D.');
      win.webContents.removeListener('did-navigate', hideWhenReady);
    }
  };
  win.webContents.on('did-navigate', hideWhenReady);
}


// ── 5. LIFECYCLE ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // UserAgent réaliste pour éviter les blocages du portail DMP
  const dmpSession = require('electron').session.fromPartition('persist:webdmp');
  dmpSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  if (SERVICE_MODE) {
    startServiceMode();           // mode résident : pas de fenêtre principale
  } else {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  // En mode service, on RESTE actif même sans fenêtre (la fenêtre DMP est masquée).
  if (SERVICE_MODE) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!SERVICE_MODE && !mainWindow) createMainWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
