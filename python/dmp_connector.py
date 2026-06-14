r"""
dmp_connector.py — accès en lecture à la base StudioVision (Access/MDB).

Expose les données nécessaires au dépôt DMP :
  - patient courant et document sélectionné, via automation COM sur l'instance
    Access en cours (StudioVision doit être ouvert sur une fiche patient) ;
  - lecture ODBC de la base pour lister documents, consultations et infos patient.

Les champs sont lus PAR NOM avec tolérance d'orthographe (`_get`) plutôt que par
position : une colonne absente ne fait pas échouer toute la requête, et les requêtes
font `SELECT *` puis filtrent les champs utiles. Les modes `--diagnostic` et
`--self-test` rendent les erreurs SQL visibles pour le débogage sur une vraie base.

Tables principales de PUBLIC.MDB :
  Patients     : [Code patient], NOM, Prénom, [Date de Naissance], SS, …
  Consultation : [Code patient], Date, Observation, DOMINANTE, REFRACTION,
                 Ordonnance, TOD, TOG, …
  Documents    : NUMDOC, [code patient], Date, DESCRIPTIONS, TEXTE,
                 [Photo externe], TypeVW   ([Photo externe] = chemin relatif
                 \<groupe>\<dossier>\<fichier>, résolu contre M:\PHOTOS)

Usage : voir `python dmp_connector.py --help`.
"""

from __future__ import annotations

import re
import io
import os
import sys
import json
import traceback
from datetime import datetime, date
from pathlib import Path

# ════════════════════════════════════════════════════════════════
# LES DEUX SEULES LIGNES À ADAPTER À VOTRE INSTALLATION
# (mettez ici les chemins exacts ; pas besoin de "set" ni de quoi que ce soit d'autre)
# ════════════════════════════════════════════════════════════════
FICHIER_MDB = Path(r"M:\fichier\PUBLIC.MDB")                  # ← votre PUBLIC.MDB
DEST_PHOTOS = Path(r"M:\PHOTOS")                              # ← dossier des photos/PDF
# ════════════════════════════════════════════════════════════════

# (Option avancée, facultative : si les variables d'environnement WEBDMP_MDB /
#  WEBDMP_PHOTOS existent, elles ont priorité. Une variable absente ou un "set"
#  raté ne change RIEN — on garde alors les deux chemins ci-dessus.)
if os.environ.get("WEBDMP_MDB"):
    FICHIER_MDB = Path(os.environ["WEBDMP_MDB"])
if os.environ.get("WEBDMP_PHOTOS"):
    DEST_PHOTOS = Path(os.environ["WEBDMP_PHOTOS"])

# Champs du formulaire patient ouvert dans StudioVision (noms de contrôles Access)
_FIELD_CODE   = "Code patient"
_FIELD_NOM    = "NOM"
_FIELD_PRENOM = "Prénom"

MAX_DOCUMENTS = 50
MAX_NOTES     = 50
# ─────────────────────────────────────────────────────────────────────────────

# Sortie UTF-8 robuste (StudioVision/Windows = accents). On protège l'accès à
# .buffer car en mode test/redirigé stdout peut déjà être un wrapper texte.
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")
except (AttributeError, ValueError):
    pass


def _log(*args, **kwargs):
    """Journal vers stderr : visible côté Electron ([Python] ...) sans polluer le JSON de stdout."""
    print(*args, **kwargs, file=sys.stderr, flush=True)


# ─── IMPORTS OPTIONNELS ───────────────────────────────────────────────────────
try:
    import pyodbc
    _PYODBC_OK = True
except ImportError:
    _PYODBC_OK = False
    _log("pyodbc non disponible (pip install pyodbc).")

try:
    import win32com.client as _win32
    _WIN32_OK = True
except ImportError:
    _WIN32_OK = False
    _log("pywin32 non disponible — détection automatique du patient désactivée.")


# ════════════════════════════════════════════════════════════════
# CONNEXION ODBC  (driver fallback + autocommit — repris de sv_reader.py)
# ════════════════════════════════════════════════════════════════

def _db_connect():
    if not _PYODBC_OK:
        raise RuntimeError("pyodbc non installé (pip install pyodbc).")
    if not FICHIER_MDB.exists():
        raise FileNotFoundError(f"PUBLIC.MDB introuvable : {FICHIER_MDB}")
    last_err = None
    for drv in ("Microsoft Access Driver (*.mdb, *.accdb)",
                "Microsoft Access Driver (*.mdb)"):
        try:
            return pyodbc.connect(f"DRIVER={{{drv}}};DBQ={FICHIER_MDB};", autocommit=True)
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(
        f"Impossible d'ouvrir {FICHIER_MDB} ({last_err}).\n"
        "Installez le pilote Access 64 bits : "
        "https://www.microsoft.com/en-us/download/details.aspx?id=54920"
    )


def _rows(conn, sql: str, params=()) -> list[dict]:
    """Exécute une requête et renvoie une liste de dictionnaires {colonne: valeur}.

    C'est LA clé de la robustesse : on n'accède jamais aux colonnes par position
    ni par un nom codé en dur dans le SELECT — on prend toute la ligne et on lit
    par nom ensuite. Un champ manquant n'écroule donc plus la requête entière.
    """
    cur = conn.cursor()
    cur.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _get(row: dict, *keys: str, default: str = "") -> str:
    """Première valeur non vide parmi plusieurs orthographes candidates."""
    for k in keys:
        v = row.get(k)
        if v is not None:
            s = str(v).strip()
            if s and s.lower() not in ("none", "nan", "null"):
                return s
    return default


def _to_code_param(code: str):
    """[Code patient] est un INTEGER dans la base. On convertit, avec repli string."""
    try:
        return int(str(code).strip())
    except (ValueError, TypeError):
        return str(code).strip()


def _fmt_date(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.strftime("%d/%m/%Y")
    s = str(value).strip()
    m = re.search(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y-%m-%d").strftime("%d/%m/%Y")
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10], fmt).strftime("%d/%m/%Y")
        except ValueError:
            continue
    return s[:10]


def _format_size(n: int) -> str:
    if n < 1024:            return f"{n} o"
    if n < 1024 * 1024:     return f"{n // 1024} Ko"
    return f"{n / (1024 * 1024):.1f} Mo"


# ════════════════════════════════════════════════════════════════
# DÉTECTION DU PATIENT ACTIF (COM)  — inchangé, déjà correct
# ════════════════════════════════════════════════════════════════

def get_active_patient() -> dict | None:
    """Lit Code/NOM/Prénom de la fiche ouverte dans StudioVision (Access via COM)."""
    if not _WIN32_OK:
        return None
    try:
        access = _win32.GetActiveObject("Access.Application")
        form   = access.Screen.ActiveForm
        if form is None:
            return None

        targets = {_FIELD_CODE, _FIELD_NOM, _FIELD_PRENOM}
        data: dict = {}
        for i in range(form.Controls.Count):
            ctrl = form.Controls(i)
            try:
                name = str(ctrl.Name)
                if name in targets:
                    data[name] = ctrl.Value
            except Exception:
                pass

        if not targets.issubset(data.keys()):
            _log("COM: champs requis absents du formulaire actif.")
            return None

        return {
            "code":   str(data[_FIELD_CODE]).strip(),
            "nom":    str(data[_FIELD_NOM]).strip().upper(),
            "prenom": str(data[_FIELD_PRENOM]).strip(),
        }
    except Exception as e:
        _log(f"COM: aucun patient actif ({e})")
        return None


# ════════════════════════════════════════════════════════════════
# DOCUMENT SÉLECTIONNÉ DANS LE SOUS-FORMULAIRE SFDoc (COM — Méthode A)
# ════════════════════════════════════════════════════════════════
# Confirmé par diagnostic : on lit la ligne sélectionnée via les contrôles liés
# au registre courant du sous-formulaire (sfdoc.Controls("Photo externe").Value…).
# La sélection suit le clic de l'utilisateur. Si le curseur est sur la ligne vide
# « nouvel enregistrement » (CurrentRecord > RecordCount), rien n'est sélectionné.

SFDOC_SUBFORM_NAME = "SFDoc"
_AC_SUBFORM = 112


def _find_sfdoc(form):
    """Recherche récursive du sous-formulaire SFDoc (repris de Box6.py)."""
    try:
        for i in range(form.Controls.Count):
            ctrl = form.Controls(i)
            try:
                if ctrl.ControlType != _AC_SUBFORM:
                    continue
                if str(ctrl.Name) == SFDOC_SUBFORM_NAME:
                    return ctrl.Form
                found = _find_sfdoc(ctrl.Form)
                if found is not None:
                    return found
            except Exception:
                pass
    except Exception:
        pass
    return None


def _ctrl_value(sfdoc, *names):
    """Première valeur de contrôle non vide parmi plusieurs noms candidats."""
    for n in names:
        try:
            v = sfdoc.Controls(n).Value
            if v is not None and str(v).strip():
                return v
        except Exception:
            continue
    return None


def get_selected_document() -> dict | None:
    """Retourne le document SÉLECTIONNÉ dans SFDoc, ou None si rien n'est sélectionné.

    Champs renvoyés : code, nom, prenom (patient), photo_externe (chemin relatif),
    description, date_str, numdoc, et type_dmp_suggere (déduit de la description).
    """
    if not _WIN32_OK:
        _log("get_selected_document: pywin32 indisponible.")
        return None
    try:
        access = _win32.GetActiveObject("Access.Application")
        form = access.Screen.ActiveForm
        if form is None:
            _log("get_selected_document: aucun formulaire actif.")
            return None
    except Exception as e:
        _log(f"get_selected_document: pas d'Access actif ({e}).")
        return None

    sfdoc = _find_sfdoc(form)
    if sfdoc is None:
        _log("get_selected_document: sous-formulaire SFDoc introuvable.")
        return None

    # Détecter la ligne vide « nouvel enregistrement » (rien de sélectionné)
    try:
        current = int(sfdoc.CurrentRecord)
        total = int(sfdoc.Recordset.RecordCount)
        if current > total:
            _log("get_selected_document: curseur sur la ligne vide — aucun document sélectionné.")
            return None
    except Exception:
        pass  # si ces propriétés échouent, on se fie au contenu lu ci-dessous

    photo = _ctrl_value(sfdoc, "Photo externe", "PhotoExterne")
    if not photo or not str(photo).strip():
        _log("get_selected_document: aucune ligne sélectionnée (Photo externe vide).")
        return None

    description = _ctrl_value(sfdoc, "Description", "DESCRIPTIONS") or ""
    description = re.sub(r"\s+", " ", str(description)).strip()  # normalise les doubles espaces

    # Patient courant (depuis le formulaire principal)
    code = _ctrl_value(form, _FIELD_CODE)
    nom = _ctrl_value(form, _FIELD_NOM)
    prenom = _ctrl_value(form, _FIELD_PRENOM)

    return {
        "code":              str(code).strip() if code else "",
        "nom":               str(nom).strip().upper() if nom else "",
        "prenom":            str(prenom).strip() if prenom else "",
        "photo_externe":     str(photo).strip(),
        "description":       description,
        "date_str":          _fmt_date(_ctrl_value(sfdoc, "Date")),
        "numdoc":            str(_ctrl_value(sfdoc, "NUMDOC") or ""),
        "type_dmp_suggere":  suggest_dmp_type(description),
    }


# ════════════════════════════════════════════════════════════════
# CORRESPONDANCE description StudioVision → type de document DMP
# ════════════════════════════════════════════════════════════════
# Donne un type DMP « par défaut » à partir de la description. L'utilisateur
# CONFIRME (et peut changer) ce type dans la fenêtre de validation, donc cette
# correspondance n'a qu'à proposer un choix raisonnable, pas parfait.

def _normalize(s: str) -> str:
    """minuscule, sans accents, espaces normalisés — pour comparer les libellés."""
    s = (s or "").lower()
    accents = str.maketrans("àâäéèêëîïôöùûüç", "aaaeeeeiioouuuc")
    s = s.translate(accents)
    return re.sub(r"\s+", " ", s).strip()

# Règles par mot-clé (ordre = priorité). Valeurs = libellés EXACTS du portail DMP.
_TYPE_RULES = [
    (("oct", "rnfl"),                         "CR d'imagerie médicale"),
    (("angio", "angiographie"),               "CR d'imagerie médicale"),
    (("retino", "etino"),                     "Document encapsulant une image d'illustration non DICOM"),
    (("topo corneen", "topo cornéen"),        "CR d'imagerie médicale"),
    (("pachymetrie",),                        "Mesures de signes vitaux"),
    (("biometrie", "iol master", "implant"),  "Mesures de signes vitaux"),
    (("champ visuel", "trend cv", "cv "),     "CR de bilan fonctionnel"),
    (("lancaster",),                          "CR de bilan fonctionnel"),
    (("bilan orthoptique", "bo"),             "CR de bilan fonctionnel"),
    (("cro",),                                "CR opératoire"),
    (("courrier",),                           "Lettre d'adressage"),
    (("schema", "schéma"),                    "CR de consultation en ophtalmologie"),
    (("consentement",),                       "Attestation de consentement"),
    (("cmu",),                                "Attestation de droits à l'assurance maladie"),
    (("devis", "lentilles", "lunettes"),      "Prescription de produits de santé"),
    (("fiche papier",),                       "CR ou fiche de consultation ou de visite"),
]

# Type par défaut si rien ne correspond : un cabinet d'ophtalmologie dépose le plus
# souvent des comptes-rendus de consultation.
_TYPE_DEFAULT = "CR de consultation en ophtalmologie"


def suggest_dmp_type(description: str) -> str:
    norm = _normalize(description)
    if not norm:
        return _TYPE_DEFAULT
    for keywords, dmp_type in _TYPE_RULES:
        for kw in keywords:
            k = _normalize(kw)
            # "bo"/"cv " etc. : éviter les correspondances trop larges en exigeant un mot entier
            if len(k) <= 3:
                if re.search(rf"(^|\W){re.escape(k.strip())}(\W|$)", norm):
                    return dmp_type
            elif k in norm:
                return dmp_type
    return _TYPE_DEFAULT


# ════════════════════════════════════════════════════════════════
# INFOS ADMINISTRATIVES PATIENT
# ════════════════════════════════════════════════════════════════

def get_patient_info(patient_code: str) -> dict:
    vide = {"code": patient_code, "nom": "—", "prenom": "—", "ddn": None, "ss": None}
    try:
        conn = _db_connect()
        try:
            rows = _rows(conn, "SELECT * FROM Patients WHERE [Code patient] = ?",
                         (_to_code_param(patient_code),))
        finally:
            conn.close()
    except Exception as e:
        _log(f"get_patient_info — échec: {e}")
        return vide

    if not rows:
        return vide

    row = rows[0]
    return {
        "code":   patient_code,
        "nom":    _get(row, "NOM").upper() or "—",
        "prenom": _get(row, "Prénom", "PRENOM", "Prenom") or "—",
        "ddn":    _fmt_date(row.get("Date de naissance")
                            or row.get("Date de Naissance")
                            or row.get("DateNaissance")
                            or row.get("DDN")) or None,
        "ss":     _get(row, "NumSecu", "NoSecu", "Secu", "NIR", "SS") or None,
    }


# ════════════════════════════════════════════════════════════════
# DOCUMENTS DU PATIENT
# ════════════════════════════════════════════════════════════════

_EXTENSIONS_UTILES = {".pdf", ".jpg", ".jpeg", ".jfif", ".png", ".tif", ".tiff",
                      ".dcm", ".doc", ".docx", ".rtf", ".odt", ".bmp"}

_TYPE_BY_EXT = {
    ".jpg": "Image", ".jpeg": "Image", ".jfif": "Image", ".png": "Image", ".bmp": "Image",
    ".tif": "OCT", ".tiff": "OCT",
    ".dcm": "DICOM",
    ".pdf": "Document", ".rtf": "Document",
    ".doc": "Document", ".docx": "Document", ".odt": "Document",
}


def _resolve_doc(photo_raw: str, dest_photos: Path) -> tuple[str, Path]:
    """Reconstruit (nom_fichier, chemin_physique) depuis [Photo externe].

    [Photo externe] = chemin RELATIF Windows, ex : \\05.000\\5182megr.leo\\img.tif
    On découpe sur / ET \\ (robuste, comme sv_reader), puis on rejoint sous DEST_PHOTOS.
    On n'utilise PAS Path(...).name sur la chaîne brute : sous un OS non-Windows
    '\\' n'est pas un séparateur, ce qui fausserait l'extension/le nom.
    """
    parts = [p for p in re.split(r"[/\\]", photo_raw) if p]
    nom_fichier = parts[-1] if parts else photo_raw
    if parts:
        chemin = Path(dest_photos).joinpath(*parts)
    else:
        chemin = Path(photo_raw)
    return nom_fichier, chemin


def _process_documents(rows: list[dict], dest_photos: Path) -> list[dict]:
    """Transforme les lignes brutes de Documents en items prêts pour l'UI. (Testable sans DB.)"""
    docs, seen = [], set()
    for row in rows:
        if len(docs) >= MAX_DOCUMENTS:
            break

        photo_raw   = _get(row, "Photo externe", "PhotoExterne", "Photo Externe")
        if not photo_raw:
            continue

        nom_fichier, chemin = _resolve_doc(photo_raw, dest_photos)
        ext = os.path.splitext(nom_fichier)[1].lower()

        if ext not in _EXTENSIONS_UTILES:
            continue
        if nom_fichier in seen:
            continue
        seen.add(nom_fichier)

        # Repli : si introuvable sous DEST_PHOTOS, tenter le chemin tel quel (absolu éventuel)
        existe = chemin.exists()
        if not existe:
            alt = Path(photo_raw)
            if alt.exists():
                chemin, existe = alt, True

        taille_str = "—"
        if existe:
            try:
                taille_str = _format_size(chemin.stat().st_size)
            except Exception:
                pass

        description = _get(row, "DESCRIPTIONS", "Description", "TypeVW")
        type_label  = description if description else _TYPE_BY_EXT.get(ext, "Document")

        docs.append({
            "id":          len(docs) + 1,           # index synthétique (pas de colonne ID en base)
            "nom":         nom_fichier,
            "type":        type_label,
            "date_str":    _fmt_date(row.get("Date")),
            "taille":      taille_str,
            "chemin":      str(chemin),
            "existe":      existe,
            "selectionne": False,
        })
    return docs


def get_patient_documents(patient_code: str) -> list[dict]:
    """Documents (images/PDF) du patient — via SELECT * (pas de colonne ID !)."""
    try:
        conn = _db_connect()
        try:
            rows = _rows(
                conn,
                "SELECT * FROM Documents "
                "WHERE [code patient] = ? AND [Photo externe] IS NOT NULL "
                "ORDER BY [Date] DESC",
                (_to_code_param(patient_code),),
            )
        finally:
            conn.close()
    except Exception as e:
        _log(f"get_patient_documents — requête échouée: {e}")
        return []

    docs = _process_documents(rows, DEST_PHOTOS)
    _log(f"get_patient_documents: {len(docs)} document(s) pour patient {patient_code} "
         f"({len(rows)} ligne(s) brute(s)).")
    if not docs:
        _log(f"  → DEST_PHOTOS={DEST_PHOTOS} | MDB={FICHIER_MDB}")
    return docs


# ════════════════════════════════════════════════════════════════
# COMPTES-RENDUS DE CONSULTATION  (table Consultation — la BONNE source)
# ════════════════════════════════════════════════════════════════

# Sentinelle : consultation sans aucun champ clinique (uniquement de l'admin).
_CR_VIDE = "(consultation sans notes)"


def _build_consultation_text(row: dict) -> tuple[str, str]:
    """Assemble (titre, contenu lisible) d'une consultation, d'après le schéma RÉEL
    de la table Consultation de StudioVision (confirmé par --diagnostic) :
      DOMINANTE, Observation, REFRACTION, LUNETTES, LENTILLES, ORTHOPTIE,
      TOD, TOG, Ordonnance, Ordonnance2, AutresPrescriptions, ObsORL, ProchainRDV.
    """
    parts: list[str] = []

    dominante   = _get(row, "DOMINANTE", "Dominante")
    observation = _get(row, "Observation", "OBSERVATION", "Observations")

    if dominante:
        parts.append(f"Motif : {dominante}")
    if observation:
        parts.append(f"Observation :\n{observation}")

    # Champs cliniques à inclure tels quels s'ils sont renseignés
    for label, keys in (
        ("Réfraction", ("REFRACTION", "Refraction", "Réfraction")),
        ("Lunettes",   ("LUNETTES",)),
        ("Lentilles",  ("LENTILLES",)),
        ("Orthoptie",  ("ORTHOPTIE",)),
        ("ORL",        ("ObsORL",)),
    ):
        val = _get(row, *keys)
        if val:
            parts.append(f"{label} :\n{val}")

    # Pression intra-oculaire (sur une ligne si l'une des deux est présente)
    tod, tog = _get(row, "TOD"), _get(row, "TOG")
    if tod or tog:
        parts.append("TOD : " + (tod or "—") + "   TOG : " + (tog or "—"))

    # Prescriptions (Ordonnance + Ordonnance2 + AutresPrescriptions)
    presc = "\n".join(filter(None, [
        _get(row, "Ordonnance"),
        _get(row, "Ordonnance2"),
        _get(row, "AutresPrescriptions", "Autres Prescriptions"),
    ]))
    if presc:
        parts.append(f"Prescriptions :\n{presc}")

    prochain = _get(row, "ProchainRDV", "Prochain RDV")
    if prochain:
        parts.append(f"Prochain RDV : {prochain}")

    # Titre : motif si présent, sinon 1re ligne de l'observation, sinon générique
    if dominante:
        titre = dominante[:60]
    elif observation:
        titre = observation.splitlines()[0][:60]
    else:
        titre = "Consultation"

    contenu = "\n\n".join(parts) if parts else _CR_VIDE
    return titre, contenu


def _process_consultations(rows: list[dict], inclure_vides: bool = False) -> list[dict]:
    """Lignes brutes de Consultation → notes prêtes pour l'UI. (Testable sans DB.)

    Par défaut, les consultations sans aucun champ clinique (purement
    administratives) sont écartées — inutile de polluer l'onglet Notes et le DMP
    avec des "(consultation sans notes)". Passer inclure_vides=True pour tout voir.
    """
    notes = []
    for row in rows:
        if len(notes) >= MAX_NOTES:
            break
        date_str = _fmt_date(row.get("Date"))
        if not date_str:
            continue
        titre, contenu = _build_consultation_text(row)
        if contenu == _CR_VIDE and not inclure_vides:
            continue
        notes.append({
            "date_str": date_str,
            "titre":    titre,
            "contenu":  contenu,
            "source":   "StudioVision · consultation",
        })
    return notes


def _process_extra_text_notes(rows: list[dict], deja_vus: set[str]) -> list[dict]:
    """Récupère en bonus les vraies notes libres stockées dans Documents.TEXTE.

    On ignore : les chemins de fichiers (TEXTE qui double [Photo externe]), les
    textes trop courts, et les doublons de contenu déjà vus côté consultations.
    """
    extra = []
    for row in rows:
        texte = _get(row, "TEXTE", "Texte")
        if not texte or len(texte) < 15:
            continue
        # écarter les chemins (\..., X:\...) ou un motif "dossier\fichier"
        if texte.startswith("\\") or (len(texte) > 2 and texte[1] == ":"):
            continue
        if re.match(r"^[\w\-\.]+\\[\w\-\.]+", texte):
            continue
        cle = texte[:80]
        if cle in deja_vus:
            continue
        deja_vus.add(cle)
        extra.append({
            "date_str": _fmt_date(row.get("Date")),
            "titre":    _get(row, "DESCRIPTIONS") or "Note",
            "contenu":  texte,
            "source":   "StudioVision · note",
        })
    return extra


def get_patient_consultations(patient_code: str) -> list[dict]:
    """Comptes-rendus de consultation + notes libres éventuelles, prêts pour l'UI.

    C'est cette fonction qui alimente l'onglet « Notes » (flag CLI --get-notes).
    """
    notes: list[dict] = []
    code_param = _to_code_param(patient_code)

    # 1) Source principale : la table Consultation
    try:
        conn = _db_connect()
        try:
            crows = _rows(
                conn,
                "SELECT * FROM Consultation WHERE [Code patient] = ? ORDER BY [Date] DESC",
                (code_param,),
            )
        finally:
            conn.close()
        notes.extend(_process_consultations(crows))
    except Exception as e:
        _log(f"get_patient_consultations — table Consultation: {e}")

    # 2) Bonus : notes libres dans Documents.TEXTE (sans casser si la requête échoue)
    try:
        conn = _db_connect()
        try:
            drows = _rows(
                conn,
                "SELECT * FROM Documents WHERE [code patient] = ? AND TEXTE IS NOT NULL "
                "ORDER BY [Date] DESC",
                (code_param,),
            )
        finally:
            conn.close()
        vus = {n["contenu"][:80] for n in notes}
        bonus = _process_extra_text_notes(drows, vus)
        if bonus:
            notes.extend(bonus[: max(0, MAX_NOTES - len(notes))])
    except Exception as e:
        _log(f"get_patient_consultations — notes Documents.TEXTE: {e}")

    _log(f"get_patient_consultations: {len(notes)} note(s)/CR pour patient {patient_code}.")
    return notes


# Alias rétro-compatible : le flag --get-notes reste identique côté Electron.
get_patient_notes = get_patient_consultations


# ════════════════════════════════════════════════════════════════
# OUTILS DE DIAGNOSTIC  (pour déboguer sur la vraie base, "main dans la main")
# ════════════════════════════════════════════════════════════════

def diagnostic() -> dict:
    """Liste les tables et les colonnes des tables clés. Aucune devinette : on lit la base."""
    info: dict = {"mdb": str(FICHIER_MDB), "photos": str(DEST_PHOTOS),
                  "mdb_existe": FICHIER_MDB.exists(), "tables": {}}
    try:
        conn = _db_connect()
        cur = conn.cursor()
        tables = [t.table_name for t in cur.tables(tableType="TABLE")]
        info["toutes_tables"] = sorted(tables)
        for t in ("Patients", "Consultation", "Documents"):
            match = next((x for x in tables if x.lower() == t.lower()), None)
            if not match:
                info["tables"][t] = {"present": False}
                continue
            cols = [c.column_name for c in cur.columns(table=match)]
            info["tables"][t] = {"present": True, "nom_reel": match, "colonnes": cols}
        conn.close()
    except Exception as e:
        info["erreur"] = f"{e}"
        info["traceback"] = traceback.format_exc()
    return info


def self_test(code: str) -> dict:
    """Exécute les 3 fonctions sur un code patient et remonte tout (erreurs comprises)."""
    out: dict = {"code": code}
    for nom, fn in (("info", get_patient_info),
                    ("documents", get_patient_documents),
                    ("notes", get_patient_consultations)):
        try:
            res = fn(code)
            if isinstance(res, list):
                out[nom] = {"nombre": len(res), "exemple": res[0] if res else None}
            else:
                out[nom] = res
        except Exception as e:
            out[nom] = {"erreur": str(e), "traceback": traceback.format_exc()}
    return out


def dump(code: str, n: int = 3) -> dict:
    """Affiche le contenu RÉEL (uniquement les champs non vides) des n dernières
    consultations et des n derniers documents d'un patient. Sert à voir exactement
    où se trouve le texte, sans rien deviner."""
    def _non_vides(row: dict) -> dict:
        res = {}
        for k, v in row.items():
            if v is None:
                continue
            s = str(v).strip()
            if s and s.lower() not in ("none", "nan", "null"):
                res[k] = s[:400]   # tronqué pour rester lisible
        return res

    out: dict = {"code": code}
    code_param = _to_code_param(code)
    try:
        conn = _db_connect()
        try:
            crows = _rows(conn, "SELECT * FROM Consultation WHERE [Code patient] = ? "
                                "ORDER BY [Date] DESC", (code_param,))
            drows = _rows(conn, "SELECT * FROM Documents WHERE [code patient] = ? "
                                "ORDER BY [Date] DESC", (code_param,))
        finally:
            conn.close()
        out["nb_consultations_total"] = len(crows)
        out["nb_documents_total"]     = len(drows)
        out["dernieres_consultations"] = [_non_vides(r) for r in crows[:n]]
        out["derniers_documents"]      = [_non_vides(r) for r in drows[:n]]
    except Exception as e:
        out["erreur"] = str(e)
        out["traceback"] = traceback.format_exc()
    return out


# ════════════════════════════════════════════════════════════════
# CLI
# ════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="WebDMP connector (v6 corrigé)")
    parser.add_argument("--get-active-patient", action="store_true")
    parser.add_argument("--get-documents", metavar="CODE")
    parser.add_argument("--get-notes",     metavar="CODE")
    parser.add_argument("--get-info",      metavar="CODE")
    parser.add_argument("--diagnostic",    action="store_true",
                        help="Liste tables + colonnes de la base (confirmer le schéma).")
    parser.add_argument("--self-test",     metavar="CODE",
                        help="Teste info+documents+notes sur un code et affiche les erreurs.")
    parser.add_argument("--dump",          metavar="CODE",
                        help="Affiche les champs non vides des 3 dernières consultations/documents.")
    parser.add_argument("--get-selected-document", action="store_true",
                        help="Lit le document sélectionné dans le sous-formulaire SFDoc de StudioVision.")
    args = parser.parse_args()

    if args.get_active_patient:
        p = get_active_patient()
        print(json.dumps(p if p else {"code": None}, ensure_ascii=False))
    elif args.get_selected_document:
        d = get_selected_document()
        print(json.dumps(d if d else {"selected": None}, ensure_ascii=False, indent=2))
    elif args.get_documents:
        print(json.dumps(get_patient_documents(args.get_documents), ensure_ascii=False, indent=2))
    elif args.get_notes:
        print(json.dumps(get_patient_consultations(args.get_notes), ensure_ascii=False, indent=2))
    elif args.get_info:
        print(json.dumps(get_patient_info(args.get_info), ensure_ascii=False, indent=2))
    elif args.diagnostic:
        print(json.dumps(diagnostic(), ensure_ascii=False, indent=2))
    elif args.self_test:
        print(json.dumps(self_test(args.self_test), ensure_ascii=False, indent=2))
    elif args.dump:
        print(json.dumps(dump(args.dump), ensure_ascii=False, indent=2))
    else:
        parser.print_help()
