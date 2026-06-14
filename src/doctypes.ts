/**
 * doctypes.ts — Liste des types de documents DMP, partagée par les fenêtres.
 * Les `value` sont les libellés EXACTS attendus par le portail Mon Espace Santé.
 * Le premier groupe « ★ Ophtalmologie » réunit les types les plus fréquents.
 */

export interface DocTypeOption { value: string; label: string; }
export interface DocTypeGroup { group: string; options: DocTypeOption[]; }

export const DOC_TYPE_GROUPS: DocTypeGroup[] = [
  { group: '★ Ophtalmologie (fréquents)', options: [
    { value: 'CR de consultation en ophtalmologie', label: 'CR de consultation en ophtalmologie' },
    { value: 'Mesures de signes vitaux', label: 'Mesures de signes vitaux (biométrie, acuité, tonus)' },
    { value: "CR d'imagerie médicale", label: "CR d'imagerie médicale (OCT, rétinographie, angiographie)" },
    { value: "Document encapsulant une image d'illustration non DICOM", label: "Image non DICOM (fond d'œil, Imagenet)" },
    { value: 'CR de bilan fonctionnel', label: 'CR de bilan fonctionnel (champ visuel, Lancaster…)' },
    { value: 'Prescription de produits de santé', label: 'Prescription de produits de santé (lunettes, lentilles, collyres)' },
    { value: 'Prescription de soins', label: 'Prescription de soins (orthoptie…)' },
    { value: "Lettre d'adressage", label: "Lettre d'adressage (courrier)" },
    { value: 'CR opératoire', label: 'CR opératoire (CRO)' },
  ]},
  { group: 'Synthèses', options: [
    { value: 'Synthèse', label: 'Synthèse' },
    { value: "Synthèse d'épisode de soins", label: "Synthèse d'épisode de soins" },
    { value: 'Synthèse médicale', label: 'Synthèse médicale' },
    { value: "Bilan de santé et de prévention de l'enfant", label: "Bilan de santé et de prévention de l'enfant" },
    { value: 'Synthèse Salle de Naissance Mère', label: 'Synthèse Salle de Naissance Mère' },
    { value: 'Synthèse Salle de Naissance Enfant', label: 'Synthèse Salle de Naissance Enfant' },
    { value: 'Synthèse Suites de Couches Mère', label: 'Synthèse Suites de Couches Mère' },
    { value: 'Synthèse Enfant en Maternité', label: 'Synthèse Enfant en Maternité' },
    { value: 'Synthèse antepartum', label: 'Synthèse antepartum' },
    { value: 'Synthèse psychiatrique', label: 'Synthèse psychiatrique' },
    { value: 'Bilan psychologique', label: 'Bilan psychologique' },
    { value: "Note de transfert (dont lettre de liaison à l'entrée en établissement de soins)", label: 'Note de transfert (lettre de liaison entrée)' },
    { value: "Lettre de liaison d'entrée en structure sociale ou médico-sociale", label: "Lettre de liaison d'entrée (structure sociale/médico-sociale)" },
    { value: 'Bilan médicamenteux (Officine)', label: 'Bilan médicamenteux (Officine)' },
    { value: 'Formulaire de conciliation médicamenteuse (Hôpital)', label: 'Formulaire de conciliation médicamenteuse (Hôpital)' },
    { value: "Document de liaison d'urgence", label: "Document de liaison d'urgence" },
    { value: 'Fiche de transfert vers le service des urgences', label: 'Fiche de transfert vers les urgences' },
    { value: 'Fiche de retour du service des urgences', label: 'Fiche de retour des urgences' },
    { value: "Grille d'évaluation médico-social", label: "Grille d'évaluation médico-social" },
    { value: 'Schéma dentaire', label: 'Schéma dentaire' },
  ]},
  { group: 'Traitements et soins', options: [
    { value: "CR d'administration de médicaments", label: "CR d'administration de médicaments" },
    { value: 'CR ou fiche de suivi de soins par auxiliaire médical', label: 'CR/fiche de suivi de soins (auxiliaire médical)' },
    { value: 'Dispensation médicamenteuse', label: 'Dispensation médicamenteuse' },
    { value: 'Dispensation (autre)', label: 'Dispensation (autre)' },
    { value: 'Plan personnalisé de soins', label: 'Plan personnalisé de soins' },
    { value: "Projet personnalisé d'accompagnement", label: "Projet personnalisé d'accompagnement" },
    { value: "Projet d'accueil individualisé", label: "Projet d'accueil individualisé" },
    { value: 'Planification thérapeutique', label: 'Planification thérapeutique' },
    { value: 'Prescription arrêt de travail', label: 'Prescription arrêt de travail' },
    { value: 'Prescription de produits de santé', label: 'Prescription de produits de santé' },
    { value: 'Prescription de soins', label: 'Prescription de soins' },
    { value: "Demande d'actes d'imagerie", label: "Demande d'actes d'imagerie" },
    { value: 'Renouvellement ordonnance par pharmacien correspondant', label: 'Renouvellement ordonnance (pharmacien correspondant)' },
    { value: 'Intervention pharmaceutique', label: 'Intervention pharmaceutique' },
    { value: "Prescription d'actes de biologie médicale", label: "Prescription d'actes de biologie médicale" },
    { value: "Prescription d'actes de kinésithérapie", label: "Prescription d'actes de kinésithérapie" },
    { value: "Prescription d'actes infirmiers", label: "Prescription d'actes infirmiers" },
    { value: "Prescription d'actes de pédicurie", label: "Prescription d'actes de pédicurie" },
    { value: "Prescription d'actes d'orthophonie", label: "Prescription d'actes d'orthophonie" },
    { value: "Prescription d'actes d'orthoptie", label: "Prescription d'actes d'orthoptie" },
    { value: 'Prescription (autre)', label: 'Prescription (autre)' },
    { value: 'Plan personnalisé de prévention', label: 'Plan personnalisé de prévention' },
    { value: 'Protocole de soins ALD', label: 'Protocole de soins ALD' },
  ]},
  { group: 'Comptes-rendus', options: [
    { value: 'CR de grossesse', label: 'CR de grossesse' },
    { value: "CR d'accouchement", label: "CR d'accouchement" },
    { value: "CR d'acte diagnostique (autre)", label: "CR d'acte diagnostique (autre)" },
    { value: "CR d'acte thérapeutique (autre)", label: "CR d'acte thérapeutique (autre)" },
    { value: "CR d'admission", label: "CR d'admission" },
    { value: "CR d'anesthésie", label: "CR d'anesthésie" },
    { value: "CR de bilan d'évaluation de la perte d'autonomie", label: "CR de bilan d'évaluation de la perte d'autonomie" },
    { value: 'Évaluation postopératoire et note de suivi', label: 'Évaluation postopératoire et note de suivi' },
    { value: 'CR de bilan fonctionnel', label: 'CR de bilan fonctionnel' },
    { value: 'CR de consultation pré-anesthésique', label: 'CR de consultation pré-anesthésique' },
    { value: 'CR de consultation en ophtalmologie', label: 'CR de consultation en ophtalmologie' },
    { value: 'CR de génétique moléculaire', label: 'CR de génétique moléculaire' },
    { value: 'CR de passage aux urgences', label: 'CR de passage aux urgences' },
    { value: 'CR de consultation pharmaceutique', label: 'CR de consultation pharmaceutique' },
    { value: "CR d'entretien pharmaceutique", label: "CR d'entretien pharmaceutique" },
    { value: 'CR de réunion de concertation pluridisciplinaire', label: 'CR de réunion de concertation pluridisciplinaire' },
    { value: 'CR de télémédecine', label: 'CR de télémédecine' },
    { value: "Demande d'acte de télémédecine", label: "Demande d'acte de télémédecine" },
    { value: 'CR hospitalier (séjour)', label: 'CR hospitalier (séjour)' },
    { value: 'Bilan bucco-dentaire', label: 'Bilan bucco-dentaire' },
    { value: 'CR opératoire', label: 'CR opératoire' },
    { value: 'Bilan par professionnel de santé', label: 'Bilan par professionnel de santé' },
    { value: 'Document du secteur social / médico-social', label: 'Document du secteur social / médico-social' },
    { value: "Lettre d'adressage", label: "Lettre d'adressage" },
    { value: 'CR ou fiche de consultation ou de visite', label: 'CR ou fiche de consultation ou de visite' },
    { value: "Lettre de liaison à la sortie d'une structure sociale ou médico-sociale", label: 'Lettre de liaison sortie (structure sociale/médico-sociale)' },
    { value: "Lettre de liaison à la sortie d'un établissement de soins", label: "Lettre de liaison sortie (établissement de soins)" },
    { value: "CR d'examen de l'enfant", label: "CR d'examen de l'enfant" },
    { value: 'Mesures de signes vitaux', label: 'Mesures de signes vitaux' },
  ]},
  { group: 'Imagerie médicale', options: [
    { value: "CR d'imagerie médicale", label: "CR d'imagerie médicale" },
    { value: "Document encapsulant une image d'illustration non DICOM", label: "Document encapsulant une image d'illustration non DICOM" },
  ]},
  { group: 'Biologie', options: [
    { value: "CR d'anatomie et de cytologie pathologiques", label: "CR d'anatomie et de cytologie pathologiques" },
    { value: "CR d'examens biologiques", label: "CR d'examens biologiques" },
  ]},
  { group: 'Prévention', options: [
    { value: "CR d'acte diagnostique à visée préventive ou de dépistage", label: "CR d'acte diagnostique à visée préventive/dépistage" },
    { value: "CR d'acte thérapeutique à visée préventive", label: "CR d'acte thérapeutique à visée préventive" },
  ]},
  { group: 'Certificats, déclarations', options: [
    { value: 'Certificat, déclaration', label: 'Certificat, déclaration' },
    { value: 'Certificat médical', label: 'Certificat médical' },
    { value: "Carte d'implant", label: "Carte d'implant" },
    { value: "Test rapide d'orientation diagnostique", label: "Test rapide d'orientation diagnostique" },
    { value: 'COVID-19 Attestation de vaccination', label: 'COVID-19 Attestation de vaccination' },
  ]},
  { group: 'Documents administratifs et de gestion', options: [
    { value: 'Attestation de consentement', label: 'Attestation de consentement' },
    { value: "Attestation de droits à l'assurance maladie", label: "Attestation de droits à l'assurance maladie" },
    { value: 'Attestation assurance complémentaire', label: 'Attestation assurance complémentaire' },
    { value: 'Attestation de résidence', label: 'Attestation de résidence' },
    { value: "Attestation d'hébergement", label: "Attestation d'hébergement" },
    { value: 'Attestation de sortie', label: 'Attestation de sortie' },
    { value: 'Autorisation de soins et actes non usuels sanitaires', label: 'Autorisation de soins et actes non usuels sanitaires' },
  ]},
];

/** Génère le HTML <optgroup>/<option> pour un <select>, avec une option présélectionnée. */
export function buildDocTypeOptionsHtml(selectedValue = ''): string {
  let html = '<option value="">— Choisir un type —</option>';
  for (const grp of DOC_TYPE_GROUPS) {
    html += `<optgroup label="${grp.group}">`;
    for (const opt of grp.options) {
      const sel = opt.value === selectedValue ? ' selected' : '';
      // échappe les guillemets doubles dans la value
      const v = opt.value.replace(/"/g, '&quot;');
      html += `<option value="${v}"${sel}>${opt.label}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}
