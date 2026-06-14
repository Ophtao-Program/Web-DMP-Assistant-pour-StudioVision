/**
 * quick_deposit.ts — Logique de la fenêtre de validation rapide (Ctrl+Alt+D).
 *
 * Le processus principal lui envoie le document sélectionné dans StudioVision via
 * 'quick-deposit-init' (avec optionsHtml = la liste des types déjà construite, le
 * type suggéré présélectionné). L'utilisateur confirme type + titre, puis « Envoyer ».
 */

interface SelectedDoc {
  code: string; nom: string; prenom: string;
  photo_externe: string; description: string; date_str: string;
  numdoc: string; type_dmp_suggere: string;
  fileName: string; filePath: string; existe: boolean;
  optionsHtml: string;
}

interface QuickApi {
  onInit: (cb: (doc: SelectedDoc) => void) => void;
  onProgress: (cb: (info: { step: string; status: string; detail?: string }) => void) => void;
  send: (opts: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  cancel: () => void;
}
declare const quickApi: QuickApi;

(() => {

const $ = (id: string) => document.getElementById(id)!;
const typeSelect  = $('type')    as HTMLSelectElement;
const titleInput  = $('title')   as HTMLInputElement;
const visibleChk  = $('visible') as HTMLInputElement;
const btnSend     = $('btn-send') as HTMLButtonElement;
const btnCancel   = $('btn-cancel') as HTMLButtonElement;
const progressBox = $('progress') as HTMLDivElement;

let current: SelectedDoc | null = null;

const STEP_LABELS: Record<string, string> = {
  preflight: 'Vérification du fichier', ecps: 'Connexion e-CPS',
  patient: 'Ouverture du DMP patient', ajout: "Formulaire d'ajout",
  fichier: 'Envoi du fichier', type: 'Type de document', titre: 'Titre',
  visibilite: 'Visibilité', soumission: 'Validation', confirmation: 'Confirmation',
  signature: 'Signature & enregistrement', termine: 'Terminé', erreur: 'Erreur',
};
const stepRows: Record<string, HTMLDivElement> = {};

function renderStep(step: string, status: string, detail?: string) {
  progressBox.style.display = 'block';
  const ic = status === 'ok' ? '✅' : status === 'error' ? '❌' : status === 'wait' ? '⏳' : '⏺';
  const color = status === 'error' ? 'var(--red)' : status === 'ok' ? 'var(--green)' : 'var(--text)';
  let row = stepRows[step];
  if (!row) {
    row = document.createElement('div');
    row.className = 'step';
    progressBox.appendChild(row);
    stepRows[step] = row;
  }
  row.innerHTML = `<span class="ic">${ic}</span><span style="flex:1;color:${color}">`
    + `<b>${STEP_LABELS[step] || step}</b>`
    + (detail ? `<br><span style="color:var(--muted)">${detail}</span>` : '')
    + `</span>`;
}

quickApi.onInit((doc) => {
  current = doc;
  $('v-patient').textContent = `${doc.nom} ${doc.prenom} (${doc.code})`;
  $('v-doc').textContent = doc.fileName + (doc.existe ? '' : '  ⚠ fichier introuvable');
  $('v-date').textContent = doc.date_str || '—';
  typeSelect.innerHTML = doc.optionsHtml;     // liste fournie par le processus principal (type suggéré présélectionné)
  // Titre par défaut : la description StudioVision (sans extension si c'est un nom de fichier)
  titleInput.value = doc.description || doc.fileName.replace(/\.[^.]+$/, '');
  titleInput.focus();
  titleInput.select();
});

quickApi.onProgress((info) => renderStep(info.step, info.status, info.detail));

btnCancel.addEventListener('click', () => quickApi.cancel());

btnSend.addEventListener('click', async () => {
  if (!current) return;
  const type = typeSelect.value.trim();
  const title = titleInput.value.trim();
  if (!type) { renderStep('type', 'error', 'Choisissez un type de document.'); typeSelect.focus(); return; }
  if (!title) { renderStep('titre', 'error', 'Indiquez un titre.'); titleInput.focus(); return; }
  if (!current.existe) { renderStep('preflight', 'error', `Fichier introuvable : ${current.filePath}`); return; }

  btnSend.disabled = true; btnCancel.disabled = true;
  renderStep('ecps', 'wait', 'Préparation…');

  const res = await quickApi.send({
    surname:      current.nom,
    filePath:     current.filePath,
    fileName:     current.fileName,
    title:        title,
    docTypeLabel: type,
    visible:      visibleChk.checked,
    background:   true,        // service de fond : fenêtre DMP masquée sauf auth
    closeWhenDone: false,
  });

  if (res.ok) {
    renderStep('termine', 'ok', 'Document déposé. Cette fenêtre se fermera.');
    setTimeout(() => quickApi.cancel(), 2500);
  } else {
    renderStep('erreur', 'error', res.error || 'Échec du dépôt.');
    btnSend.disabled = false; btnCancel.disabled = false;
  }
});

// Échap = annuler
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') quickApi.cancel(); });

})();
