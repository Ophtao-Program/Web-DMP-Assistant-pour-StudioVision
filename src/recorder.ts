/**
 * recorder.ts — Générateur du script d'enregistrement injecté dans la page Web DMP.
 *
 * RÔLE
 *   Produit le code JavaScript qui sera injecté (executeJavaScript) dans le
 *   webContents de la fenêtre Web DMP. Ce code observe TOUTES les interactions
 *   de l'utilisateur sur le portail Mon Espace Santé et les renvoie au processus
 *   principal Electron via window.__dmpRecorderSink(event), exposé côté preload.
 *
 * POURQUOI
 *   Mon Espace Santé n'a pas d'API publique de dépôt. Pour automatiser le geste,
 *   on doit d'abord apprendre EXACTEMENT quels champs/boutons l'utilisateur
 *   manipule, dans quel ordre, avec quelles valeurs. Ce log devient le scénario
 *   de référence à partir duquel on écrira le rejeu automatique (phase suivante).
 *
 * CE QUI EST CAPTURÉ pour chaque action
 *   - type d'événement (click, input, change, focus, blur, submit, keydown utiles,
 *     navigation, ouverture/fermeture de la page, apparition de boîtes de dialogue)
 *   - identité COMPLÈTE de l'élément cible :
 *       tag, type, id, name, classes, role, aria-label, placeholder, title,
 *       texte visible, valeur (masquée si champ sensible), label associé,
 *       sélecteur CSS robuste, XPath absolu, chemin de frame (iframe)
 *   - contexte page : url, titre, taille viewport, horodatage ms
 *
 * CONFIDENTIALITÉ
 *   Les valeurs des champs mot de passe et des champs marqués sensibles ne sont
 *   jamais journalisées en clair : on enregistre la longueur et le fait qu'il y a
 *   eu saisie, pas le contenu.
 */

export function buildRecorderScript(sessionId: string): string {
  const sid = JSON.stringify(sessionId);

  // Le corps ci-dessous s'exécute DANS la page DMP. Il doit rester autonome
  // (pas d'import), idempotent (ne pas s'installer deux fois), et défensif
  // (la moindre exception ne doit jamais gêner l'utilisateur sur le portail).
  return `
(function() {
  if (window.__dmpRecorderInstalled) { return "already"; }
  window.__dmpRecorderInstalled = true;

  var SESSION_ID = ${sid};
  var seq = 0;

  // ── Remontée d'un événement vers Electron ──────────────────────────────────
  function emit(obj) {
    try {
      obj.session = SESSION_ID;
      obj.seq = (++seq);
      obj.t = Date.now();
      obj.url = location.href;
      obj.pageTitle = document.title;
      if (typeof window.__dmpRecorderSink === 'function') {
        window.__dmpRecorderSink(obj);
      }
    } catch (e) { /* ne jamais perturber la page */ }
  }

  // ── Échappement CSS ─────────────────────────────────────────────────────────
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }

  // ── Sélecteur CSS robuste (id > attributs stables > chemin nth-child) ────────
  function cssSelector(el) {
    if (!(el instanceof Element)) return null;
    if (el.id) return '#' + cssEscape(el.id);

    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();

      // attributs stables fréquents sur les portails (data-testid, name, role)
      var stable = node.getAttribute('data-testid') || node.getAttribute('data-test')
                || node.getAttribute('name');
      if (stable) {
        part += '[' + (node.getAttribute('data-testid') ? 'data-testid' :
                       node.getAttribute('data-test') ? 'data-test' : 'name')
              + '="' + stable.replace(/"/g, '\\\\"') + '"]';
        parts.unshift(part);
        break; // suffisamment discriminant
      }

      // sinon position parmi les frères de même tag
      var parent = node.parentNode;
      if (parent) {
        var sib = parent.children;
        var idx = 0, count = 0, found = -1;
        for (var i = 0; i < sib.length; i++) {
          if (sib[i].tagName === node.tagName) {
            count++;
            if (sib[i] === node) found = count;
          }
        }
        if (count > 1 && found > 0) part += ':nth-of-type(' + found + ')';
      }
      parts.unshift(part);
      node = node.parentNode;
      depth++;
    }
    return parts.join(' > ');
  }

  // ── XPath absolu ──────────────────────────────────────────────────────────
  function xpath(el) {
    if (!(el instanceof Element)) return null;
    if (el.id) return '//*[@id="' + el.id + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var ix = 1;
      var sib = node.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName === node.tagName) ix++;
        sib = sib.previousSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + ix + ']');
      node = node.parentNode;
      if (node === document.body) { parts.unshift('body'); break; }
    }
    return '/' + parts.join('/');
  }

  // ── Label associé à un champ de formulaire ──────────────────────────────────
  function labelFor(el) {
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (l) return (l.textContent || '').trim().slice(0, 120);
      }
      var p = el.closest('label');
      if (p) return (p.textContent || '').trim().slice(0, 120);
      var aria = el.getAttribute('aria-label');
      if (aria) return aria.trim().slice(0, 120);
      var labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        var ref = document.getElementById(labelledby);
        if (ref) return (ref.textContent || '').trim().slice(0, 120);
      }
    } catch (e) {}
    return null;
  }

  // ── Champ sensible ? (mot de passe / marqué sensible) ───────────────────────
  function isSensitive(el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.indexOf('password') !== -1 || ac.indexOf('one-time-code') !== -1) return true;
    var name = (el.getAttribute('name') || '').toLowerCase();
    if (/pass|secret|otp|cvc|cvv/.test(name)) return true;
    return false;
  }

  // ── Valeur d'un champ (masquée si sensible) ─────────────────────────────────
  function safeValue(el) {
    try {
      if (el.value === undefined) return undefined;
      if (isSensitive(el)) return { masked: true, length: String(el.value).length };
      var v = String(el.value);
      if (v.length > 500) v = v.slice(0, 500) + '…[tronqué]';
      return v;
    } catch (e) { return undefined; }
  }

  // ── Chemin de frame (si l'enregistreur est injecté dans une iframe) ─────────
  function framePath() {
    try { return (window.top === window.self) ? 'main' : (location.pathname || 'iframe'); }
    catch (e) { return 'cross-origin-frame'; }
  }

  // ── Portrait complet d'un élément ────────────────────────────────────────────
  function describe(el) {
    if (!(el instanceof Element)) return null;
    var rect = null;
    try { var r = el.getBoundingClientRect(); rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) {}
    var text = '';
    try { text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120); } catch (e) {}
    return {
      tag:         el.tagName ? el.tagName.toLowerCase() : null,
      type:        el.getAttribute ? el.getAttribute('type') : null,
      id:          el.id || null,
      name:        el.getAttribute ? el.getAttribute('name') : null,
      classes:     el.className && el.className.toString ? el.className.toString().slice(0, 200) : null,
      role:        el.getAttribute ? el.getAttribute('role') : null,
      ariaLabel:   el.getAttribute ? el.getAttribute('aria-label') : null,
      placeholder: el.getAttribute ? el.getAttribute('placeholder') : null,
      title:       el.getAttribute ? el.getAttribute('title') : null,
      dataTestId:  el.getAttribute ? (el.getAttribute('data-testid') || el.getAttribute('data-test')) : null,
      href:        el.getAttribute ? el.getAttribute('href') : null,
      label:       labelFor(el),
      text:        text || null,
      css:         cssSelector(el),
      xpath:       xpath(el),
      rect:        rect,
      frame:       framePath()
    };
  }

  // ── Écouteurs (capture = true pour voir l'événement avant tout stopPropagation) ─
  document.addEventListener('click', function(e) {
    emit({ kind: 'click', target: describe(e.target),
           button: e.button, x: e.clientX, y: e.clientY });
  }, true);

  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    emit({ kind: 'input', target: describe(el),
           value: safeValue(el), sensitive: isSensitive(el) });
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var info = { kind: 'change', target: describe(el),
                 value: safeValue(el), sensitive: isSensitive(el) };
    // <select> : capter aussi le libellé de l'option choisie
    if (el.tagName.toLowerCase() === 'select' && el.options && el.selectedIndex >= 0) {
      var opt = el.options[el.selectedIndex];
      info.selectedText = opt ? (opt.textContent || '').trim().slice(0, 120) : null;
    }
    if (el.type === 'checkbox' || el.type === 'radio') info.checked = !!el.checked;
    if (el.type === 'file') {
      info.files = Array.prototype.map.call(el.files || [], function(f) {
        return { name: f.name, size: f.size, type: f.type };
      });
    }
    emit(info);
  }, true);

  document.addEventListener('focus', function(e) {
    if (e.target && e.target.tagName) emit({ kind: 'focus', target: describe(e.target) });
  }, true);

  document.addEventListener('blur', function(e) {
    if (e.target && e.target.tagName) emit({ kind: 'blur', target: describe(e.target) });
  }, true);

  document.addEventListener('submit', function(e) {
    emit({ kind: 'submit', target: describe(e.target) });
  }, true);

  // Touches « structurantes » uniquement (pas de keylogging du contenu)
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
      emit({ kind: 'key', key: e.key, target: describe(e.target) });
    }
  }, true);

  // Apparition de nouveaux éléments importants (modales, boutons d'upload, toasts)
  try {
    var mo = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          var role = n.getAttribute && n.getAttribute('role');
          var isDialog = role === 'dialog' || role === 'alertdialog'
                      || (n.className && /modal|dialog|popin|popup|toast|snackbar/i.test(n.className.toString()));
          if (isDialog) {
            emit({ kind: 'dom-appear', target: describe(n),
                   info: 'modale/dialogue apparue' });
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  emit({ kind: 'recorder-ready', info: 'enregistreur installé' });
  return "installed";
})();
`;
}
