# WebDMP Assistant

Pont logiciel entre **StudioVision** (logiciel de cabinet d'ophtalmologie, basé sur
Microsoft Access) et le **DMP / Mon Espace Santé**. L'outil lit le document
sélectionné dans la fiche patient ouverte dans StudioVision et le dépose dans le
DMP du patient via le portail web professionnel, après authentification Pro Santé
Connect (e-CPS).

L'objectif est d'éviter la double saisie et le passage manuel par le portail :
le praticien reste dans StudioVision, sélectionne un document, et un raccourci
clavier (`Ctrl+Alt+D`) déclenche le dépôt.

Le code est écrit en TypeScript (Electron) pour la partie automatisation du portail
et en Python pour le pont COM/ODBC avec StudioVision.

## Prérequis

- **Windows** (testé sur Windows 7 et 10 — StudioVision tourne encore sur des postes Seven).
- **Node.js 18+** et npm.
- **Python 3.9+** avec les dépendances de `requirements.txt` (`pip install -r requirements.txt`) :
  `pywin32` pour le pont COM, `pyodbc` pour la lecture ODBC de la base.
- **StudioVision installé et ouvert** sur le poste, avec une fiche patient affichée.
- Le partage réseau des documents patients monté (par défaut `M:`, voir Configuration).
- Une **carte e-CPS** (ou carte CPS + lecteur) pour l'authentification Pro Santé Connect,
  et un compte habilité sur Mon Espace Santé Pro.

Le pont COM s'appuie sur l'automation Access ; il faut donc qu'Access (ou le runtime
StudioVision) expose l'objet `Access.Application`, ce qui est le cas quand StudioVision
est lancé normalement.

## Installation

```bat
git clone <url-du-depot> webdmp-app
cd webdmp-app
npm install
npm run build
```

`npm run build` compile les deux cibles TypeScript (processus principal + interface)
définies dans `tsconfig.json` et `src/renderer/tsconfig.json`. Le résultat va dans `dist/`.

## Lancement

Deux modes, selon l'usage.

**Mode service (usage courant).** Lancer `Se-Connecter-WebDMP (sans fenetre).vbs`.
Le lanceur démarre Electron sans fenêtre console : la fenêtre du portail DMP s'ouvre
le temps de valider l'authentification e-CPS, puis se masque. Une icône apparaît dans
la zone de notification et le raccourci global `Ctrl+Alt+D` devient actif. À partir de
là, sélectionner un document dans StudioVision puis `Ctrl+Alt+D` ouvre une fenêtre de
confirmation (patient, document, type DMP pré-rempli) ; après validation, le dépôt se
fait en arrière-plan. La session e-CPS est réutilisée tant que le service tourne — pas
de reconnexion entre deux envois. Un clic gauche sur l'icône vérifie si la session
est encore active. Le menu (clic droit) permet de (re)lancer la connexion, d'ouvrir
les journaux, et de quitter.

La toute première exécution déclenche `npm install` puis la compilation dans une
fenêtre visible (le temps de l'installation), après quoi le service démarre.

**Mode interface (mise au point, dépôt manuel).** `Lancer WebDMP.bat`, ou `npm start`.
Ouvre la fenêtre principale : détection du patient courant, liste des documents,
sélection manuelle, et le même moteur de dépôt avec affichage détaillé des étapes.

## Architecture

Application Electron classique (processus principal + preloads + renderer), plus un
script Python appelé en sous-processus pour tout ce qui touche à StudioVision.

```
src/
  main.ts            Processus principal : fenêtres, mode service, tray,
                     raccourci global, IPC, appels au connecteur Python.
  preload.ts         Pont de l'interface principale.
  preload_dmp.ts     Pont injecté dans la fenêtre du portail DMP (enregistreur).
  preload_quick.ts   Pont de la fenêtre de confirmation (Ctrl+Alt+D).
  replay.ts          Moteur de dépôt : pilote le portail DMP étape par étape.
  recorder.ts        Capture des actions dans le portail (mise au point).
  logwriter.ts       Journaux de session (JSONL + lisible).
  doctypes.ts        Liste des types de documents DMP + correspondance.
  renderer/          Interface (index.html / renderer.ts) et fenêtre de
                     confirmation (quick_deposit.html / quick_deposit.ts).
python/
  dmp_connector.py   Pont COM (Access) + lecture ODBC de la base StudioVision.
```

Le dépôt sur le portail passe par une fenêtre `BrowserWindow` dédiée, avec une session
persistante (`persist:webdmp`) qui conserve l'authentification entre les envois. En mode
service cette fenêtre reste masquée sauf pendant l'authentification.

## Le pont avec StudioVision (COM)

StudioVision est une base Access. Le projet VBA est protégé, on ne peut donc pas l'étendre
de l'intérieur ; à la place, `dmp_connector.py` se connecte par automation COM à l'instance
Access en cours d'exécution (`win32com.client.GetActiveObject("Access.Application")`).

Deux lectures :

- **Patient courant** — les contrôles du formulaire actif (`Screen.ActiveForm`) donnent
  le code patient, le nom et le prénom.
- **Document sélectionné** — le sous-formulaire des documents s'appelle `SFDoc`. On le
  retrouve en parcourant récursivement l'arbre des contrôles (`ControlType = 112`), puis
  on lit la ligne courante via les contrôles liés au registre (`sfdoc.Controls("Photo externe").Value`,
  `sfdoc.Controls("Description").Value`, etc.). La lecture suit la ligne réellement
  sélectionnée par l'utilisateur. Le cas du curseur sur la ligne vide de saisie
  (`CurrentRecord > RecordCount`) est détecté et traité comme « aucun document sélectionné ».

```bat
python python\dmp_connector.py --get-selected-document
```

renvoie en JSON le chemin relatif du fichier (`Photo externe`), la description, le patient,
et un type DMP suggéré. Le chemin relatif (du type `\GG.000\<dossier-patient>\fichier.pdf`) est
résolu contre la racine des documents (`M:\PHOTOS` par défaut).

Le connecteur propose aussi `--get-active-patient`, `--get-documents CODE`,
`--get-notes CODE`, `--diagnostic` et `--self-test CODE` (lecture seule, utiles au débogage).

## Le dépôt sur le portail DMP

`replay.ts` pilote le portail web. Les sélecteurs sont stables (pages rendues côté serveur,
identifiants `#…`). Enchaînement :

1. Authentification Pro Santé Connect (clic e-CPS, validation sur le téléphone).
   La page de transit OIDC `index2` se soumet d'elle-même ; le moteur n'injecte rien
   pour éviter de rejouer un jeton à usage unique.
2. Liste « Mes patients » → ouverture du DMP du patient (correspondance par nom).
3. Formulaire d'ajout de document : dépôt du fichier dans `#file` via le protocole
   DevTools (`DOM.setFileInputFiles`, sans boîte de dialogue Windows), choix du type
   (`#typeDocument`), titre (`#TitreDocument`, obligatoire), visibilité.
4. Validation, confirmation, signature automatique, puis retour au récapitulatif.

Si une session est déjà active, le moteur va directement à la page DMP plutôt que de
relancer le tunnel OIDC (relancer OIDC sur une session active fait échouer le portail).
En cas de refus du formulaire, le message d'erreur réel est remonté plutôt qu'un simple
délai d'attente.

Formats acceptés par le portail : jpeg, jpg, txt, pdf, rtf, tif, tiff — 5 Mo maximum.

## Correspondance description → type DMP

`suggest_dmp_type()` (dans `dmp_connector.py`) déduit un type DMP par défaut à partir de la
description StudioVision, par mots-clés. Quelques exemples : les biométries et l'IOLMaster →
*Mesures de signes vitaux* ; OCT, RNFL, angiographie, topographie → *CR d'imagerie médicale* ;
rétinographies → *Document encapsulant une image d'illustration non DICOM* ; champ visuel,
Lancaster → *CR de bilan fonctionnel* ; CRO → *CR opératoire* ; courriers → *Lettre
d'adressage*. À défaut, *CR de consultation en ophtalmologie*. La suggestion n'est qu'un
point de départ : le type est confirmé (et modifiable) dans la fenêtre avant l'envoi.

La liste complète des types proposés par le portail vit dans `src/doctypes.ts`, avec un
groupe « Ophtalmologie » regroupant en tête les types les plus utilisés.

## Configuration

- `WEBDMP_MDB` — chemin de la base StudioVision (défaut `M:\fichier\PUBLIC.MDB`).
- `WEBDMP_PHOTOS` — racine des documents patients (défaut `M:\PHOTOS`).
- L'identifiant e-CPS saisi dans l'interface est conservé dans
  `%APPDATA%\webdmp-app\config.json`.

Variables d'environnement à passer sous PowerShell avec `$env:WEBDMP_PHOTOS = "..."`
(et non `set`).

## Dépannage

- **Une fenêtre console reste ouverte au lancement** — lancer le `.vbs`, pas le `.bat`.
  Le `.bat` exécute Electron au premier plan ; fermer la console couperait le service.
- **« Le patient n'est pas dans votre espace DMP »** — il faut d'abord l'ajouter depuis
  le portail (Mon Espace Santé Pro) avec sa carte Vitale ou son INS, puis relancer l'envoi.
- **Erreur après authentification (« Erreur générale »)** — généralement une session OIDC
  rejouée. Le comportement est géré ; si elle persiste, quitter le service et relancer.
- **`--get-selected-document` renvoie `selected: null`** — aucun document n'est sélectionné
  (curseur sur la ligne vide). Cliquer une ligne de document dans la fiche patient.
- Deux journaux, accessibles via le menu de l'icône, dans `%APPDATA%\webdmp-app\` :
  `journal_technique.txt` (trace complète de chaque opération, pour le diagnostic) et
  `rapport_medecin.txt` (liste datée des documents envoyés/échoués par patient).

## Limites connues

- La sélection du patient repose sur sa présence dans « Mes patients » (recherche par nom).
  La recherche/création par INS depuis l'outil n'est pas implémentée.
- Seuls les documents sont traités, pas les notes / comptes-rendus libres.
- Le projet VBA de StudioVision étant verrouillé, l'intégration se fait par-dessus
  (raccourci global + lecture COM) et non dans les menus du logiciel.
