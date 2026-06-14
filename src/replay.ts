/**
 * replay.ts — Moteur de dépôt sur le DMP (Mon Espace Santé).
 *
 * Pilote le portail web professionnel à l'aide de ses identifiants stables.
 * Tout est automatisé sauf la validation e-CPS sur mobile, imposée par Pro Santé
 * Connect. La fenêtre du portail et le clic e-CPS initial sont gérés par main.ts.
 *
 * Parcours :
 *   [validation e-CPS sur téléphone, ≤120 s]
 *   → index2              : bounce OIDC (la page se soumet seule)
 *   → mespatients/raz     : clic du lien patient #openDMPLink… (par nom)
 *   → dmp/recapitulatif   : clic #ajoutDoc
 *   → ajoutdocument       : fichier sur #file (via CDP), #typeDocument,
 *                           #TitreDocument, #confidentiality0, #submit
 *   → demandeconfirmation : clic #accept
 *   → signaturedocument → confirmationajout : dépôt confirmé
 *
 * Garde-fous (on écrit dans un dossier médical réel) :
 *   - chaque étape attend sa précondition (URL ou élément) ;
 *   - au moindre écart, arrêt et reprise manuelle ;
 *   - les actions de validation (#submit, #accept) ne sont jamais cliquées deux fois ;
 *   - contrôle du fichier (format + taille ≤ 5 Mo) avant de commencer.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface DepositOptions {
  surname: string;        // nom de famille du patient (pour retrouver le lien DMP)
  filePath: string;       // chemin physique du document à déposer
  fileName: string;       // nom de fichier affiché
  title: string;          // titre du document dans le DMP (champ obligatoire #TitreDocument)
  docTypeLabel: string;   // libellé du type DMP (ex. "Mesures de signes vitaux")
  visible: boolean;       // case "visible par toute personne autorisée"
  background?: boolean;   // tâche de fond : fenêtre DMP masquée sauf pendant l'authentification
  closeWhenDone?: boolean;// quitter le DMP à la fin
}

export type ProgressFn = (info: { step: string; status: 'run' | 'ok' | 'wait' | 'error'; detail?: string }) => void;

const ACCEPTED_EXT = ['.jpeg', '.jpg', '.txt', '.pdf', '.rtf', '.tif', '.tiff'];
const MAX_SIZE = 5 * 1024 * 1024;   // 5 Mo

// ── Utilitaires d'attente ────────────────────────────────────────────────────

/** Attend que l'URL de la fenêtre satisfasse `test`. Gère le bounce index2. */
function waitForUrl(win: BrowserWindow, test: (url: string) => boolean,
                    timeoutMs: number, onBounce?: (url: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const wc = win.webContents;

    const finish = (err: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(iv);
      clearTimeout(to);
      wc.removeListener('did-navigate', onNav);
      wc.removeListener('did-navigate-in-page', onNav);
      if (err) reject(err); else resolve(url!);
    };

    const check = () => {
      if (settled) return;
      let url = '';
      try { url = wc.getURL(); } catch { return; }
      if (onBounce) onBounce(url);
      if (test(url)) finish(null, url);
    };

    const onNav = () => check();
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onNav);

    const iv = setInterval(check, 500);
    const to = setTimeout(() => finish(new Error('Délai dépassé')), timeoutMs);
    check();
  });
}

/** Attend qu'un sélecteur soit présent dans la page (poll executeJavaScript). */
async function waitForSelector(win: BrowserWindow, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const js = `!!document.querySelector(${JSON.stringify(selector)})`;
  while (Date.now() < deadline) {
    try {
      const found = await win.webContents.executeJavaScript(js);
      if (found) return true;
    } catch { /* page en cours de navigation */ }
    await sleep(300);
  }
  return false;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/**
 * Attend la fin de l'authentification : résout dès qu'on atteint une page
 * authentifiée (URL /mespatients ou /dmp/) OU que la liste patients est présente
 * (liens openDMPLink…) — utile car DMP_HOME authentifié peut atterrir à la racine.
 * `onTick` est appelé à chaque vérification avec l'URL courante.
 */
async function waitForAuthenticated(win: BrowserWindow, timeoutMs: number,
                                    onTick?: (url: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let u = '';
    try { u = win.webContents.getURL(); } catch {}
    if (onTick) onTick(u);
    if (/\/mespatients/.test(u) || /\/dmp\//.test(u)) return;
    try {
      const onList = await win.webContents.executeJavaScript(
        `!!document.querySelector('a[id^="openDMPLink"]')`
      );
      if (onList) return;
    } catch { /* page en navigation */ }
    await sleep(500);
  }
  throw new Error('Délai dépassé');
}

// ── Scripts exécutés DANS la page DMP ────────────────────────────────────────

/** Clique un élément par sélecteur ; renvoie {ok}. */
async function clickSelector(win: BrowserWindow, selector: string): Promise<{ ok: boolean }> {
  const js = `(function(){ var el=document.querySelector(${JSON.stringify(selector)});
    if(!el){return {ok:false};} el.scrollIntoView({block:'center'}); el.click(); return {ok:true}; })();`;
  return win.webContents.executeJavaScript(js);
}

/** Clique le lien patient dont le texte contient le nom de famille. */
async function clickPatientLink(win: BrowserWindow, surname: string): Promise<{ ok: boolean; found?: string[]; id?: string }> {
  const js = `(function(){
    var sn = ${JSON.stringify(surname.toUpperCase())};
    var links = Array.prototype.slice.call(document.querySelectorAll('a[id^="openDMPLink"]'));
    var hit = links.filter(function(a){ return (a.textContent||'').toUpperCase().indexOf(sn) !== -1; })[0];
    if(!hit){ return {ok:false, found: links.map(function(a){return (a.textContent||'').trim().slice(0,40);})}; }
    hit.scrollIntoView({block:'center'}); hit.click();
    return {ok:true, id: hit.id};
  })();`;
  return win.webContents.executeJavaScript(js);
}

/** Sélectionne l'option du #typeDocument correspondant au libellé voulu.
 *  Stratégie : valeur exacte en priorité (ce que le <select> local envoie),
 *  puis texte exact, puis texte partiel insensible à la casse. */
async function selectDocType(win: BrowserWindow, label: string): Promise<{ ok: boolean; chosen?: string; options?: string[] }> {
  const js = `(function(){
    var sel = document.querySelector('#typeDocument');
    if(!sel){ return {ok:false, options:[]}; }
    var target = ${JSON.stringify(label.trim())};
    var targetLow = target.toLowerCase();
    var opts = Array.prototype.slice.call(sel.options);
    // 1) correspondance exacte sur value (le cas normal : on envoie la value DMP exacte)
    var m = opts.filter(function(o){ return o.value === target; })[0];
    // 2) correspondance exacte sur text (fallback)
    if(!m) m = opts.filter(function(o){ return o.text.trim() === target; })[0];
    // 3) correspondance partielle insensible à la casse (dernier recours)
    if(!m) m = opts.filter(function(o){
      return o.value && o.text.trim().toLowerCase().indexOf(targetLow) !== -1;
    })[0];
    if(!m){ return {ok:false, options: opts.map(function(o){return o.value||o.text.trim();}).filter(Boolean)}; }
    var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
    setter.call(sel, m.value);
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true, chosen: m.value};
  })();`;
  return win.webContents.executeJavaScript(js);
}

/** Coche (si besoin) la case de visibilité, ou la décoche selon `visible`. */
async function setVisibility(win: BrowserWindow, visible: boolean): Promise<{ ok: boolean; checked?: boolean }> {
  const js = `(function(){
    var c = document.querySelector('#confidentiality0');
    if(!c){ return {ok:false}; }
    var want = ${visible ? 'true' : 'false'};
    if(c.checked !== want){ c.click(); }
    return {ok:true, checked: c.checked};
  })();`;
  return win.webContents.executeJavaScript(js);
}

/** Remplit le champ obligatoire « Titre » (#TitreDocument). */
async function fillTitle(win: BrowserWindow, title: string): Promise<{ ok: boolean }> {
  const js = `(function(){
    var el = document.querySelector('#TitreDocument') || document.querySelector('[name="TitreDocument"]');
    if(!el){ return {ok:false}; }
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(el, ${JSON.stringify(title)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true};
  })();`;
  return win.webContents.executeJavaScript(js);
}

/** Lit le bloc d'erreurs de validation du formulaire DMP, s'il y en a un. */
async function readFormErrors(win: BrowserWindow): Promise<string> {
  const js = `(function(){
    var parts = [];
    var sel = '.error, .errors, .alert-danger, [class*="erreur"], [class*="error"], .messagesErreur, #messages';
    var blocks = document.querySelectorAll(sel);
    for (var i=0;i<blocks.length && parts.length<6;i++){
      var s = (blocks[i].innerText||'').trim().replace(/\\s+/g,' ');
      if (s && parts.indexOf(s)===-1) parts.push(s);
    }
    if (!parts.length){
      var body = document.body ? document.body.innerText : '';
      var m = body.match(/Certaines données[\\s\\S]{0,250}/);
      if (m) parts.push(m[0].replace(/\\s+/g,' ').trim());
    }
    return parts.join(' · ').slice(0, 400);
  })();`;
  try { return await win.webContents.executeJavaScript(js); } catch { return ''; }
}

/** Après clic sur #submit : distingue succès (page de confirmation) et refus (retour formulaire). */
async function waitAfterSubmit(win: BrowserWindow, timeoutMs = 18000): Promise<'ok' | 'rejected'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let u = '';
    try { u = win.webContents.getURL(); } catch {}
    if (/demandeconfirmationactiondocument/.test(u)) return 'ok';
    // Le formulaire poste vers ajoutdocument.formajoutdocument ; s'il y reste, c'est un refus
    if (/ajoutdocument\.formajoutdocument/.test(u)) {
      await sleep(600); // laisser le DOM d'erreurs se peindre
      return 'rejected';
    }
    await sleep(400);
  }
  return 'rejected';
}

/** Lit la liste des types de documents proposés (pour configurer l'UI). */
export async function readDocTypes(win: BrowserWindow): Promise<string[]> {
  const js = `(function(){
    var sel = document.querySelector('#typeDocument');
    if(!sel){ return []; }
    return Array.prototype.slice.call(sel.options).map(function(o){return o.text.trim();}).filter(Boolean);
  })();`;
  try { return await win.webContents.executeJavaScript(js); } catch { return []; }
}

/** Pose le fichier sur l'input #file via le protocole DevTools (contourne le sélecteur OS). */
async function setFileInput(win: BrowserWindow, selector: string, filePath: string): Promise<void> {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  try {
    const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const q: any = await dbg.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId, selector,
    });
    if (!q || !q.nodeId) throw new Error('input #file introuvable via CDP');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [filePath] });
  } finally {
    try { dbg.detach(); } catch { /* ignore */ }
  }
  // S'assurer que la page réagit (au cas où setFileInputFiles ne propage pas l'event)
  const js = `(function(){ var f=document.querySelector(${JSON.stringify(selector)});
    if(f){ f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true})); } })();`;
  await win.webContents.executeJavaScript(js).catch(() => {});
}

// ── Contrôle préalable du fichier ────────────────────────────────────────────

export function preflight(opts: DepositOptions): { ok: boolean; reason?: string } {
  if (!opts.filePath) return { ok: false, reason: 'Aucun fichier indiqué.' };
  if (!fs.existsSync(opts.filePath)) return { ok: false, reason: `Fichier introuvable : ${opts.filePath}` };
  const ext = path.extname(opts.filePath).toLowerCase();
  if (!ACCEPTED_EXT.includes(ext))
    return { ok: false, reason: `Format ${ext} non accepté par le DMP (acceptés : ${ACCEPTED_EXT.join(', ')}).` };
  let size = 0;
  try { size = fs.statSync(opts.filePath).size; } catch {}
  if (size > MAX_SIZE)
    return { ok: false, reason: `Fichier trop volumineux (${(size / 1024 / 1024).toFixed(1)} Mo > 5 Mo).` };
  if (!opts.surname) return { ok: false, reason: 'Nom du patient manquant.' };
  if (!opts.docTypeLabel) return { ok: false, reason: 'Type de document DMP non choisi.' };
  if (!opts.title || !opts.title.trim()) return { ok: false, reason: 'Titre du document manquant (champ obligatoire).' };
  return { ok: true };
}

// ── Orchestration complète ───────────────────────────────────────────────────

export async function runDeposit(win: BrowserWindow, opts: DepositOptions, emit: ProgressFn): Promise<{ ok: boolean; error?: string }> {
  const step = (step: string, status: 'run' | 'ok' | 'wait' | 'error', detail?: string) => emit({ step, status, detail });
  // En tâche de fond, on réaffiche la fenêtre si quelque chose échoue (reprise manuelle).
  const reveal = () => { if (opts.background) { try { win.show(); win.focus(); } catch { /* ignore */ } } };

  try {
    // 0. Contrôle préalable
    step('preflight', 'run');
    const pf = preflight(opts);
    if (!pf.ok) { step('preflight', 'error', pf.reason); return { ok: false, error: pf.reason }; }
    step('preflight', 'ok', `${opts.fileName} · type « ${opts.docTypeLabel} »`);

    // 1. Attendre la fin de l'authentification e-CPS (validation mobile)
    //    On résout dès qu'on atteint la liste patients ou le récapitulatif.
    //
    //    IMPORTANT : la page de bounce OIDC `/index2` SE SOUMET TOUTE SEULE au
    //    chargement (formulaire #formJs auto-posté). Il ne faut donc RIEN injecter
    //    ici : une 2ᵉ soumission rejoue un jeton OIDC à usage unique → HTTP 403 sur
    //    /index2.formjs. On se contente d'attendre, exactement comme en manuel.
    //    Filet de sécurité : UNE seule soumission, et seulement si la page est
    //    restée bloquée sur /index2 (chemin exact) plus de 12 s — cas anormal.
    //
    //    Mode tâche de fond : la fenêtre est masquée. On l'AFFICHE uniquement quand
    //    on détecte une page d'authentification (PSC), puis on la MASQUE une fois
    //    l'authentification passée. Si on est déjà connecté, elle reste masquée.
    step('ecps', 'wait', opts.background
      ? 'Validation e-CPS : la fenêtre va s\'afficher si besoin. Validez sur votre téléphone…'
      : 'Validez la connexion e-CPS sur votre téléphone (≤120 s)…');
    let firstIndex2At = 0;
    let safetySubmitted = false;
    let shownForAuth = false;
    await waitForAuthenticated(
      win,
      135000,
      (u) => {
        // Afficher la fenêtre dès qu'on est sur une page d'authentification PSC
        if (opts.background && !shownForAuth) {
          const onAuthPage = /wallet\.esw\.esante\.gouv\.fr/.test(u)
                          || /auth\.esw\.esante\.gouv\.fr/.test(u);
          if (onAuthPage) {
            shownForAuth = true;
            try { win.show(); win.focus(); } catch { /* ignore */ }
            step('ecps', 'wait', 'Fenêtre affichée pour la validation e-CPS — validez sur votre téléphone.');
          }
        }
        let pathname = '';
        try { pathname = new URL(u).pathname; } catch { return; }
        if (pathname !== '/index2') return;            // n'agit QUE sur /index2 exact
        if (!firstIndex2At) firstIndex2At = Date.now();
        if (!safetySubmitted && Date.now() - firstIndex2At > 12000) {
          safetySubmitted = true;                       // une seule fois
          win.webContents.executeJavaScript(
            `(function(){var b=document.querySelector('#submitFormJs');if(b)b.click();})();`
          ).catch(() => {});
        }
      }
    );
    // Authentifié : en tâche de fond, on masque la fenêtre et tout se poursuit invisible.
    if (opts.background) { try { win.hide(); } catch { /* ignore */ } }
    step('ecps', 'ok', opts.background
      ? 'Connexion validée — fenêtre masquée, dépôt en arrière-plan.'
      : 'Connexion e-CPS validée.');

    // 2. Sélection du patient (si on n'est pas déjà dans son DMP)
    if (!/\/dmp\/recapitulatif/.test(win.webContents.getURL())) {
      step('patient', 'run', `Recherche du patient « ${opts.surname} » dans la liste…`);
      await waitForSelector(win, 'a[id^="openDMPLink"]', 15000);
      const p = await clickPatientLink(win, opts.surname);
      if (!p.ok) {
        const presents = (p.found && p.found.length)
          ? ` Patients actuellement dans « Mes patients » : ${p.found.join(', ')}.`
          : '';
        const msg = `Le patient « ${opts.surname} » n'est pas dans votre espace DMP. `
          + `Avant de pouvoir lui transmettre un document, ajoutez-le depuis le portail `
          + `(Mon Espace Santé Pro) avec sa carte Vitale ou son identifiant INS, `
          + `puis relancez l'envoi.` + presents;
        step('patient', 'error', msg);
        reveal();
        return { ok: false, error: msg };
      }
      await waitForUrl(win, (u) => /\/dmp\/recapitulatif/.test(u), 20000);
      step('patient', 'ok', 'DMP du patient ouvert.');
    } else {
      step('patient', 'ok', 'DMP du patient déjà ouvert.');
    }

    // 3. Ouvrir le formulaire d'ajout de document
    step('ajout', 'run');
    if (!(await waitForSelector(win, '#ajoutDoc', 10000))) throw new Error('Lien « Ajouter un document » introuvable.');
    await clickSelector(win, '#ajoutDoc');
    await waitForUrl(win, (u) => /\/ajoutdocument/.test(u), 20000);
    if (!(await waitForSelector(win, '#file', 10000))) throw new Error('Formulaire d\'ajout incomplet (#file absent).');
    step('ajout', 'ok');

    // 4. Poser le fichier (CDP)
    step('fichier', 'run', opts.fileName);
    await setFileInput(win, '#file', opts.filePath);
    await sleep(400);
    step('fichier', 'ok');

    // 5. Choisir le type de document
    step('type', 'run', opts.docTypeLabel);
    if (!(await waitForSelector(win, '#typeDocument', 8000))) throw new Error('Menu « Type du document » absent.');
    const t = await selectDocType(win, opts.docTypeLabel);
    if (!t.ok) {
      const msg = `Type « ${opts.docTypeLabel} » introuvable. Types proposés : ${(t.options || []).join(' | ')}`;
      step('type', 'error', msg);
      reveal();
      return { ok: false, error: msg };
    }
    step('type', 'ok', `« ${t.chosen} »`);

    // 6. Titre du document (champ obligatoire #TitreDocument)
    step('titre', 'run', opts.title);
    if (!(await waitForSelector(win, '#TitreDocument', 6000)))
      throw new Error('Champ « Titre » (#TitreDocument) introuvable sur le formulaire.');
    const ti = await fillTitle(win, opts.title.trim());
    if (!ti.ok) { step('titre', 'error', 'Impossible de remplir le titre.'); reveal(); return { ok: false, error: 'Titre non rempli.' }; }
    step('titre', 'ok', `« ${opts.title.trim()} »`);

    // 7. Visibilité
    step('visibilite', 'run');
    await setVisibility(win, opts.visible);
    step('visibilite', 'ok', opts.visible ? 'visible par tout professionnel autorisé' : 'visibilité restreinte');

    // 8. Soumettre, puis distinguer succès / refus (avec lecture des erreurs)
    step('soumission', 'run');
    await sleep(300);
    if (!(await waitForSelector(win, '#submit', 8000))) throw new Error('Bouton de validation (#submit) absent.');
    await clickSelector(win, '#submit');
    const verdict = await waitAfterSubmit(win, 18000);
    if (verdict === 'rejected') {
      const errs = await readFormErrors(win);
      const msg = 'Le formulaire a été refusé par le DMP'
                + (errs ? ` : ${errs}` : ' (données manquantes ou incorrectes).');
      step('soumission', 'error', msg);
      reveal();
      return { ok: false, error: msg };
    }
    step('soumission', 'ok');

    // 9. Confirmer l'ajout
    step('confirmation', 'run');
    if (!(await waitForSelector(win, '#accept', 10000))) throw new Error('Bouton de confirmation (#accept) absent.');
    await clickSelector(win, '#accept');

    // 10. Attendre la confirmation finale (la signature est automatique)
    step('signature', 'wait', 'Signature et enregistrement…');
    await waitForUrl(win, (u) => /confirmationajout/.test(u), 30000);
    step('signature', 'ok', 'Document déposé et signé.');

    // 11. Retour au récapitulatif (et sortie éventuelle)
    if (await waitForSelector(win, '#recapitulatif', 8000)) {
      await clickSelector(win, '#recapitulatif');
      await waitForUrl(win, (u) => /\/dmp\/recapitulatif/.test(u), 15000).catch(() => {});
    }
    if (opts.closeWhenDone && await waitForSelector(win, '#closeDMPLink', 5000)) {
      await clickSelector(win, '#closeDMPLink');
    }

    step('termine', 'ok', `« ${opts.fileName} » déposé dans le DMP de ${opts.surname}.`);
    return { ok: true };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    step('erreur', 'error', msg + ' — reprise manuelle possible dans la fenêtre DMP.');
    reveal();
    return { ok: false, error: msg };
  }
}
