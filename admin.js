/* ============================================================
   Rendez-vous — page admin (Supabase Auth + gestion)
   ============================================================ */

const { createClient } = supabase;
const sb = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

(() => {
  const el = (id) => document.getElementById(id);
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABELS = {
    mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi',
    fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche'
  };

  // État global : rôle de la personne connectée + son équipe. Rempli par
  // loadTeamAndRole() juste après la connexion.
  const state = {
    currentUser: null,
    isOwner: false,
    myEmployee: null,
    employees: [],       // toute l'équipe (RLS: tout le monde voit les actif·ve·s)
    services: [],
    apptView: 'list',
    apptsById: {}         // cache des rendez-vous affichés, utilisé par le panneau "Déplacer"
  };

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  function money(cents) {
    if (cents === null || cents === undefined || cents === '') return '';
    return (cents / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
  }

  function humanDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('fr-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function hhmm(t) {
    return t ? t.slice(0, 5) : t;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------------
  // Photo de profil (avatar) — photo si dispo, sinon initiales du nom.
  // Gérée uniquement par le/la propriétaire, depuis l'onglet Équipe.
  // ------------------------------------------------------------------
  const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
  const PHOTO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  function initials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0][0] || '';
    const second = parts.length > 1 ? parts[1][0] : '';
    return (first + second).toUpperCase();
  }

  function avatarHTML(emp, size) {
    const cls = `avatar${size ? ' avatar-' + size : ''}`;
    if (emp.photo_url) {
      return `<img class="${cls}" src="${escapeHtml(emp.photo_url)}" alt="" />`;
    }
    return `<div class="${cls}">${escapeHtml(initials(emp.full_name))}</div>`;
  }

  async function uploadEmployeePhoto(file, employeeId) {
    if (!PHOTO_ALLOWED_TYPES.includes(file.type)) {
      throw new Error('Format non supporté — utilise une image JPG, PNG ou WebP.');
    }
    if (file.size > PHOTO_MAX_BYTES) {
      throw new Error('Image trop grande (max 5 Mo).');
    }
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${employeeId}/${Date.now()}.${ext}`;
    const { error: upErr } = await sb.storage.from('employee-photos').upload(path, file, {
      cacheControl: '3600',
      upsert: true
    });
    if (upErr) throw upErr;
    const { data } = sb.storage.from('employee-photos').getPublicUrl(path);
    return data.publicUrl;
  }

  function photoWidgetHTML(emp) {
    return `
      <div class="photo-widget">
        <div data-avatar="${emp.id}">${avatarHTML(emp, 'lg')}</div>
        <div class="photo-actions">
          <button type="button" class="btn-small neutral" data-photo-trigger>Changer la photo</button>
          <button type="button" class="btn-small danger ${emp.photo_url ? '' : 'hidden'}" data-photo-remove>Retirer la photo</button>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-photo-input style="display:none" />
          <span class="save-note" data-photo-note></span>
        </div>
      </div>
    `;
  }

  function wirePhotoWidget(row, emp) {
    const input = row.querySelector('[data-photo-input]');
    const avatarWrap = row.querySelector('[data-avatar]');
    const note = row.querySelector('[data-photo-note]');
    const removeBtn = row.querySelector('[data-photo-remove]');
    const triggerBtn = row.querySelector('[data-photo-trigger]');

    triggerBtn.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      note.textContent = 'Téléversement…';
      try {
        const url = await uploadEmployeePhoto(file, emp.id);
        const { error } = await sb.from('employees').update({ photo_url: url }).eq('id', emp.id);
        if (error) throw error;
        emp.photo_url = url;
        avatarWrap.innerHTML = avatarHTML(emp, 'lg');
        removeBtn.classList.remove('hidden');
        note.textContent = 'Photo mise à jour.';
        setTimeout(() => (note.textContent = ''), 2000);
      } catch (err) {
        note.textContent = err.message || 'Erreur lors du téléversement.';
      }
    });

    removeBtn.addEventListener('click', async () => {
      if (!confirm('Retirer la photo ?')) return;
      const { error } = await sb.from('employees').update({ photo_url: null }).eq('id', emp.id);
      if (error) {
        alert(error.message);
        return;
      }
      emp.photo_url = null;
      avatarWrap.innerHTML = avatarHTML(emp, 'lg');
      removeBtn.classList.add('hidden');
    });
  }

  // ------------------------------------------------------------------
  // Heures (jsonb {mon:{closed,open,close}, ...}) — utilisé pour l'horaire
  // général du commerce, "Mon horaire" et l'horaire de chaque employé(e)
  // dans l'onglet Équipe.
  // ------------------------------------------------------------------
  function buildHoursRows(container, hoursObj) {
    container.innerHTML = '';
    DAY_KEYS.forEach((day) => {
      const h = (hoursObj && hoursObj[day]) || { closed: true, open: '09:00', close: '17:00' };
      const row = document.createElement('div');
      row.className = 'day-row';
      row.dataset.day = day;
      row.innerHTML = `
        <div class="day-name">${DAY_LABELS[day]}</div>
        <label class="day-closed-toggle">
          <input type="checkbox" class="f-closed" ${h.closed ? 'checked' : ''} />
          Fermé
        </label>
        <div class="day-times" style="${h.closed ? 'opacity:.4' : ''}">
          <input type="time" class="f-open" value="${h.open}" ${h.closed ? 'disabled' : ''} />
          <span>à</span>
          <input type="time" class="f-close" value="${h.close}" ${h.closed ? 'disabled' : ''} />
        </div>
      `;
      container.appendChild(row);

      row.querySelector('.f-closed').addEventListener('change', (e) => {
        const closed = e.target.checked;
        row.querySelector('.day-times').style.opacity = closed ? '.4' : '1';
        row.querySelector('.f-open').disabled = closed;
        row.querySelector('.f-close').disabled = closed;
      });
    });
  }

  function readHoursRows(container) {
    const hours = {};
    container.querySelectorAll('.day-row').forEach((row) => {
      const day = row.dataset.day;
      hours[day] = {
        closed: row.querySelector('.f-closed').checked,
        open: row.querySelector('.f-open').value || '09:00',
        close: row.querySelector('.f-close').value || '17:00'
      };
    });
    return hours;
  }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  // Un lien d'invitation ou de mot de passe oublié ajoute #type=invite ou
  // #type=recovery à l'URL. Supabase déclenche un évènement différent
  // selon la version/le cas (PASSWORD_RECOVERY ou simplement SIGNED_IN) —
  // on se base donc aussi sur l'URL pour être sûr de rediriger vers
  // l'étape "choisis ton mot de passe" dans les deux cas.
  const urlAuthType = new URLSearchParams(window.location.hash.slice(1)).get('type');

  async function checkSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) showApp(session.user);
    else showLogin();
  }

  function showLogin() {
    el('login-overlay').classList.remove('hidden');
    el('admin-app').classList.add('hidden');
  }

  async function showApp(user) {
    el('login-overlay').classList.add('hidden');
    el('admin-app').classList.remove('hidden');
    el('admin-user-email').textContent = user?.email || '';
    el('public-link').value = window.location.origin + window.location.pathname.replace(/admin\.html$/, '');
    state.currentUser = user;

    await loadBusinessName();
    await loadServices();
    await loadTeamAndRole();
    loadAppointments();
    loadSettings();
  }

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = el('login-error');
    const info = el('login-info');
    errBox.classList.add('hidden');
    info.textContent = '';
    const btn = el('login-btn');
    btn.disabled = true;
    btn.textContent = 'Connexion…';

    const { data, error } = await sb.auth.signInWithPassword({
      email: el('login-email').value.trim(),
      password: el('login-password').value
    });

    btn.disabled = false;
    btn.textContent = 'Se connecter';

    if (error) {
      errBox.textContent = 'Identifiants invalides.';
      errBox.classList.remove('hidden');
      return;
    }
    showApp(data.user);
  });

  el('forgot-pwd-link').addEventListener('click', async (e) => {
    e.preventDefault();
    const errBox = el('login-error');
    const info = el('login-info');
    errBox.classList.add('hidden');
    info.textContent = '';

    const email = (el('login-email').value || prompt('Entre ton courriel :') || '').trim();
    if (!email) return;

    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      errBox.textContent = error.message;
      errBox.classList.remove('hidden');
      return;
    }
    info.textContent = `Un courriel a été envoyé à ${email}. Clique le lien pour choisir un nouveau mot de passe.`;
  });

  // Quand l'utilisateur clique le lien reçu par courriel (mot de passe oublié
  // ou invitation), Supabase déclenche une session valide.
  sb.auth.onAuthStateChange((event, session) => {
    const isRecoveryOrInvite = event === 'PASSWORD_RECOVERY'
      || (event === 'SIGNED_IN' && (urlAuthType === 'invite' || urlAuthType === 'recovery'));
    if (isRecoveryOrInvite && session) {
      showApp(session.user).then(() => {
        document.querySelector('[data-tab="account"]').click();
        if (urlAuthType === 'invite') {
          const note = el('pwd-note');
          if (note) note.textContent = 'Bienvenue ! Choisis ton mot de passe ci-dessous pour activer ton compte.';
        }
      });
    }
  });

  el('logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.reload();
  });

  async function loadBusinessName() {
    const { data } = await sb.from('business_settings').select('business_name').eq('id', true).single();
    const name = data?.business_name || 'Mon salon';
    el('admin-biz-name').textContent = name;
    document.title = `Administration — ${name}`;
  }

  el('copy-link-btn').addEventListener('click', async () => {
    const input = el('public-link');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      document.execCommand('copy');
    }
    const btn = el('copy-link-btn');
    const original = btn.textContent;
    btn.textContent = 'Copié !';
    setTimeout(() => (btn.textContent = original), 1500);
  });

  // ------------------------------------------------------------------
  // Onglets
  // ------------------------------------------------------------------
  // Chaque changement d'onglet crée sa propre entrée dans l'historique du
  // navigateur, pour que le bouton "Retour" revienne à l'onglet précédent
  // au lieu de carrément quitter /admin.html (même bug/correctif que sur
  // la page client — voir client.js).
  let tabInHistory = null;

  function activateTab(tabName, opts) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (!btn || btn.classList.contains('hidden')) return;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    el(`tab-${tabName}`).classList.remove('hidden');

    if (opts && opts.fromHistory) {
      tabInHistory = tabName;
      return;
    }
    if (tabName === tabInHistory) return; // déjà l'onglet actif, rien à ajouter à l'historique
    if (tabInHistory === null) {
      // Tout premier onglet affiché après le chargement de la page : sert
      // de point d'ancrage, sans créer de nouvelle entrée.
      history.replaceState({ tab: tabName }, '', location.href);
    } else {
      history.pushState({ tab: tabName }, '', location.href);
    }
    tabInHistory = tabName;
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.tab) activateTab(e.state.tab, { fromHistory: true });
  });

  // Ancre l'onglet affiché par défaut au chargement ("Rendez-vous") dans
  // l'historique, pour que le tout premier "Retour" quitte normalement la
  // page plutôt que de rester coincé dessus.
  activateTab('appointments');

  // ------------------------------------------------------------------
  // Équipe + rôle (propriétaire vs employé(e))
  // ------------------------------------------------------------------
  async function loadTeamAndRole() {
    const [{ data: employees, error }, { data: empServices }] = await Promise.all([
      sb.from('employees').select('*').order('role', { ascending: false }).order('full_name', { ascending: true }),
      sb.from('employee_services').select('employee_id, service_id')
    ]);

    if (error) {
      console.error('Erreur de chargement de l\'équipe :', error.message);
      return;
    }

    const svcMap = {};
    (empServices || []).forEach((row) => {
      if (!svcMap[row.employee_id]) svcMap[row.employee_id] = new Set();
      svcMap[row.employee_id].add(row.service_id);
    });

    state.employees = (employees || []).map((e) => ({ ...e, serviceIds: svcMap[e.id] || new Set() }));
    state.myEmployee = state.employees.find((e) => e.user_id === state.currentUser?.id) || null;
    state.isOwner = state.myEmployee?.role === 'owner';
    state.multiEmployee = state.employees.filter((e) => e.active).length > 1;

    applyRoleVisibility();
    populateEmployeeFilter();

    if (state.myEmployee) {
      el('my-name-input').value = state.myEmployee.full_name || '';
      renderMyPhoto();
    }

    if (state.isOwner) {
      renderTeamList();
    } else if (state.myEmployee) {
      buildHoursRows(el('hours-mine-list'), state.myEmployee.hours);
      renderMyServices();
    }
  }

  function applyRoleVisibility() {
    el('tab-btn-services').classList.toggle('hidden', !state.isOwner);
    el('tab-btn-team').classList.toggle('hidden', !state.isOwner);
    el('hours-owner-section').classList.toggle('hidden', !state.isOwner);
    el('hours-mine-card').classList.toggle('hidden', state.isOwner);
    el('my-services-card').classList.toggle('hidden', state.isOwner);

    // Si l'onglet actif vient d'être caché (ex. reconnexion sous un autre
    // rôle), retombe sur Rendez-vous.
    const activeBtn = document.querySelector('.tab-btn.active');
    if (activeBtn && activeBtn.classList.contains('hidden')) {
      document.querySelector('[data-tab="appointments"]').click();
    }
  }

  function populateEmployeeFilter() {
    const sel = el('employee-filter');
    const show = state.isOwner && state.multiEmployee;
    sel.classList.toggle('hidden', !show);
    const current = sel.value;
    sel.innerHTML = '<option value="">Toute l\'équipe</option>' +
      state.employees.filter((e) => e.active).map((e) => `<option value="${e.id}">${escapeHtml(e.full_name)}</option>`).join('');
    if (show) sel.value = current;
  }

  el('employee-filter').addEventListener('change', () => {
    if (state.apptView === 'calendar') renderCalendar();
    else loadAppointments();
  });

  function renderTeamList() {
    const list = el('team-list');
    if (!state.employees.length) {
      list.innerHTML = '<p class="empty-note">Aucun membre pour le moment.</p>';
      return;
    }
    list.innerHTML = '';

    state.employees.forEach((emp) => {
      const row = document.createElement('div');
      row.className = 'service-row';

      if (emp.role === 'owner') {
        row.innerHTML = `
          <div class="grid2">
            <div><label>Nom</label><input type="text" value="${escapeHtml(emp.full_name)}" disabled /></div>
            <div><label>Courriel</label><input type="email" value="${escapeHtml(emp.email)}" disabled /></div>
          </div>
          <p class="empty-note" style="padding-top:0;">Propriétaire — gère les services, l'horaire général et l'équipe. Modifie son propre nom et sa propre photo dans l'onglet Compte.</p>
        `;
        list.appendChild(row);
        return;
      }

      row.innerHTML = `
        ${photoWidgetHTML(emp)}
        <p class="empty-note" style="padding-top:0;">Une photo mise ici est visible pour la cliente/le client ; ${escapeHtml(emp.full_name.split(' ')[0])} peut aussi la changer elle-même/lui-même depuis son propre onglet Compte une fois connecté(e).</p>
        <div class="grid2">
          <div>
            <label>Nom</label>
            <input type="text" class="f-name" value="${escapeHtml(emp.full_name)}" />
          </div>
          <div>
            <label>Téléphone</label>
            <input type="tel" class="f-phone" value="${escapeHtml(emp.phone || '')}" />
          </div>
        </div>
        <label>Courriel</label>
        <input type="email" value="${escapeHtml(emp.email)}" disabled />
        <div class="checkbox-line">
          <input type="checkbox" class="f-active" id="emp-active-${emp.id}" ${emp.active ? 'checked' : ''} />
          <label for="emp-active-${emp.id}">Actif (visible pour les client·e·s, peut se connecter)</label>
        </div>
        <label style="margin-top:14px;">Services offerts</label>
        <div class="checkbox-grid" data-services><p class="empty-note">Aucun service créé.</p></div>
        <label style="margin-top:14px;">Horaire</label>
        <div data-hours></div>
        <div class="row-actions">
          <button class="btn-small danger" data-remove-emp="${emp.id}">Retirer</button>
          <button class="btn-small primary" data-save-emp="${emp.id}">Enregistrer</button>
        </div>
      `;
      list.appendChild(row);
      wirePhotoWidget(row, emp);

      const svcWrap = row.querySelector('[data-services]');
      if (state.services.length) {
        svcWrap.innerHTML = state.services.map((s) => `
          <label class="checkbox-line svc-check">
            <input type="checkbox" class="f-svc" value="${s.id}" ${emp.serviceIds?.has(s.id) ? 'checked' : ''} />
            ${escapeHtml(s.name)}
          </label>
        `).join('');
      }

      const hrsWrap = row.querySelector('[data-hours]');
      buildHoursRows(hrsWrap, emp.hours);

      row.querySelector('[data-save-emp]').addEventListener('click', async () => {
        const btn = row.querySelector('[data-save-emp]');
        btn.disabled = true;

        const { error: empErr } = await sb.from('employees').update({
          full_name: row.querySelector('.f-name').value.trim(),
          phone: row.querySelector('.f-phone').value.trim() || null,
          active: row.querySelector('.f-active').checked,
          hours: readHoursRows(hrsWrap)
        }).eq('id', emp.id);

        if (empErr) {
          btn.disabled = false;
          alert(empErr.message);
          return;
        }

        const selectedIds = Array.from(row.querySelectorAll('.f-svc:checked')).map((cb) => cb.value);
        await sb.from('employee_services').delete().eq('employee_id', emp.id);
        if (selectedIds.length) {
          await sb.from('employee_services').insert(selectedIds.map((sid) => ({ employee_id: emp.id, service_id: sid })));
        }

        btn.disabled = false;
        btn.textContent = 'Enregistré !';
        setTimeout(() => (btn.textContent = 'Enregistrer'), 1200);
        loadTeamAndRole();
      });

      row.querySelector('[data-remove-emp]').addEventListener('click', async () => {
        if (!confirm(`Retirer ${emp.full_name} de l'équipe ? Ses rendez-vous déjà pris restent dans l'historique — désactive-la plutôt si tu préfères juste la cacher.`)) return;
        const { error } = await sb.from('employees').delete().eq('id', emp.id);
        if (error) {
          alert(`Impossible de la retirer complètement (probablement parce qu'elle a des rendez-vous) : ${error.message}\nDésactive-la plutôt en décochant "Actif".`);
          return;
        }
        loadTeamAndRole();
      });
    });
  }

  el('add-employee-btn').addEventListener('click', async () => {
    const errBox = el('new-emp-error');
    const note = el('new-emp-note');
    errBox.classList.add('hidden');
    note.textContent = '';

    const full_name = el('new-emp-name').value.trim();
    const phone = el('new-emp-phone').value.trim();
    const email = el('new-emp-email').value.trim();

    if (!full_name || !email) {
      errBox.textContent = 'Le nom et le courriel sont requis.';
      errBox.classList.remove('hidden');
      return;
    }

    const btn = el('add-employee-btn');
    btn.disabled = true;
    btn.textContent = 'Envoi…';

    const redirect_to = window.location.origin + window.location.pathname;
    // ⚠️ Ta fonction a été déployée sous l'URL "swift-api" (slug généré
    // automatiquement par Supabase, différent du nom affiché "invite-employee"
    // dans la liste Edge Functions) — même quirk que "bright-action" pour les
    // notifications. Si tu redéploies un jour sous le vrai nom, remplace la
    // chaîne ci-dessous par 'invite-employee'.
    const { data, error } = await sb.functions.invoke('swift-api', {
      body: { full_name, phone, email, redirect_to }
    });

    btn.disabled = false;
    btn.textContent = "Envoyer l'invitation";

    if (error || data?.error) {
      let code = data?.error || '';
      if (!code && error?.context?.json) {
        try { code = (await error.context.json())?.error || ''; } catch { /* ignore */ }
      }
      const messages = {
        EMPLOYEE_ALREADY_EXISTS: 'Cette personne fait déjà partie de ton équipe.',
        AUTH_USER_ALREADY_EXISTS: 'Un compte existe déjà avec ce courriel.',
        FORBIDDEN_NOT_OWNER: "Seul(e) le/la propriétaire peut ajouter des employé(e)s.",
        MISSING_FULL_NAME: 'Le nom est requis.',
        INVALID_EMAIL: 'Courriel invalide.'
      };
      errBox.textContent = messages[code] || "Une erreur est survenue. Vérifie que l'edge function \"invite-employee\" est bien déployée (voir DEPLOYMENT.md).";
      errBox.classList.remove('hidden');
      return;
    }

    el('new-emp-name').value = '';
    el('new-emp-phone').value = '';
    el('new-emp-email').value = '';
    note.textContent = `Invitation envoyée à ${email}.`;
    loadTeamAndRole();
  });

  // ------------------------------------------------------------------
  // Rendez-vous — helpers partagés entre la vue Liste et la vue Calendrier
  // ------------------------------------------------------------------
  // Le 2e/3e argument (idx, arr) vient gratuitement de .map(apptRowHTML) —
  // "arr" est la liste (du même jour) en cours d'affichage, utilisée ici
  // pour repérer les AUTRES rendez-vous de la même visite multi-services
  // (booking_group_id partagé) et les indiquer visuellement.
  function apptRowHTML(a, _idx, arr) {
    state.apptsById[a.id] = a;
    let groupNote = '';
    if (a.booking_group_id && arr) {
      const siblings = arr.filter((x) => x.booking_group_id === a.booking_group_id && x.id !== a.id);
      if (siblings.length) {
        groupNote = `<div class="group-note">Même visite : ${siblings.map((s) => escapeHtml(s.service_name)).join(', ')}</div>`;
      }
    }
    return `
      <div class="appt-row-wrap">
        <div class="appt-row">
          <div class="time">${hhmm(a.start_time)} – ${hhmm(a.end_time)}</div>
          <div class="info">
            <div class="service">${escapeHtml(a.service_name)}${state.multiEmployee ? ` <span class="employee-tag">${escapeHtml(a.employee_name)}</span>` : ''}</div>
            ${groupNote}
            <div class="client">${escapeHtml(a.client_name)} · ${escapeHtml(a.client_phone)} · ${escapeHtml(a.client_email)}</div>
          </div>
          <span class="badge ${a.status}">${a.status === 'cancelled' ? 'Annulé' : 'Confirmé'}</span>
          ${a.status !== 'cancelled' ? `
            <button class="btn-small neutral" data-edit="${a.id}">Modifier</button>
            <button class="btn-small warning" data-move="${a.id}">Déplacer</button>
            <button class="btn-small danger" data-cancel="${a.id}">Annuler</button>
          ` : ''}
        </div>
        ${a.status !== 'cancelled' ? `<div class="edit-panel hidden" data-edit-panel="${a.id}"></div>` : ''}
        ${a.status !== 'cancelled' ? `<div class="move-panel hidden" data-move-panel="${a.id}"></div>` : ''}
      </div>
    `;
  }

  function wireCancelButtons(container, onCancelled) {
    container.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = state.apptsById[btn.dataset.cancel];
        const groupNote = a && a.booking_group_id ? ' (les autres services de cette visite ne seront pas touchés)' : '';
        if (!confirm(`Annuler ce rendez-vous ?${groupNote}`)) return;
        btn.disabled = true;
        const { error } = await sb.from('appointments').update({ status: 'cancelled' }).eq('id', btn.dataset.cancel);
        if (error) {
          alert(error.message);
          btn.disabled = false;
          return;
        }
        onCancelled();
      });
    });
  }

  // ------------------------------------------------------------------
  // Rendez-vous — déplacer (change la date/l'heure, courriel automatique
  // "rendez-vous déplacé" envoyé par le déclencheur Postgres correspondant)
  // ------------------------------------------------------------------
  function wireMoveButtons(container, onMoved) {
    container.querySelectorAll('[data-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.move;
        const panel = container.querySelector(`[data-move-panel="${id}"]`);
        if (!panel) return;
        const wasOpen = !panel.classList.contains('hidden');
        container.querySelectorAll('.move-panel, .edit-panel').forEach((p) => p.classList.add('hidden'));
        if (wasOpen) return;
        panel.classList.remove('hidden');
        renderMovePanel(panel, id, onMoved);
      });
    });
  }

  function renderMovePanel(panel, apptId, onMoved) {
    const a = state.apptsById[apptId];
    if (!a) {
      panel.innerHTML = '<p class="empty-note">Rendez-vous introuvable — recharge la page.</p>';
      return;
    }

    panel.innerHTML = `
      <label>Nouvelle date</label>
      <input type="date" class="move-date-input" value="${a.appt_date}" min="${todayISO()}" />
      <div class="move-slots-wrap" style="margin-top:12px;">
        <p class="empty-note move-slots-note">Chargement des disponibilités…</p>
        <div class="slots-grid move-slots-grid"></div>
      </div>
      <button type="button" class="btn-small" data-move-close="${apptId}" style="margin-top:12px;">Fermer</button>
    `;

    const dateInput = panel.querySelector('.move-date-input');
    const slotsGrid = panel.querySelector('.move-slots-grid');
    const slotsNote = panel.querySelector('.move-slots-note');

    panel.querySelector('[data-move-close]').addEventListener('click', () => {
      panel.classList.add('hidden');
    });

    async function loadMoveSlots() {
      const date = dateInput.value;
      slotsGrid.innerHTML = '';
      if (!date) {
        slotsNote.textContent = 'Choisis une date pour voir les disponibilités.';
        return;
      }
      slotsNote.textContent = 'Chargement…';
      // p_exclude_appointment_id : ignore le rendez-vous qu'on est en train de
      // déplacer dans le calcul des disponibilités, sinon son propre créneau
      // (et la marge autour) semblerait "pris" par lui-même.
      const { data: slots, error } = await sb.rpc('get_available_slots', {
        p_service_id: a.service_id,
        p_employee_id: a.employee_id,
        p_date: date,
        p_exclude_appointment_id: apptId
      });
      if (error) {
        slotsNote.textContent = `Erreur : ${error.message}`;
        return;
      }
      if (!slots || !slots.length) {
        slotsNote.textContent = 'Aucune disponibilité ce jour-là.';
        return;
      }
      slotsNote.textContent = '';
      slotsGrid.innerHTML = slots
        .map((s) => `<button type="button" class="slot-btn" data-start="${s.start_time}" data-end="${s.end_time}">${hhmm(s.start_time)}</button>`)
        .join('');
      slotsGrid.querySelectorAll('.slot-btn').forEach((slotBtn) => {
        slotBtn.addEventListener('click', async () => {
          const newStart = slotBtn.dataset.start;
          const newEnd = slotBtn.dataset.end;
          if (!confirm(`Déplacer le rendez-vous de ${a.client_name} au ${humanDate(date)} à ${hhmm(newStart)} ?`)) return;
          slotsGrid.querySelectorAll('.slot-btn').forEach((b) => (b.disabled = true));
          const { error: updErr } = await sb
            .from('appointments')
            .update({ appt_date: date, start_time: newStart, end_time: newEnd })
            .eq('id', apptId);
          if (updErr) {
            alert(updErr.message);
            slotsGrid.querySelectorAll('.slot-btn').forEach((b) => (b.disabled = false));
            return;
          }
          onMoved();
        });
      });
    }

    dateInput.addEventListener('change', loadMoveSlots);
    loadMoveSlots();
  }

  // ------------------------------------------------------------------
  // Rendez-vous — modifier les coordonnées de la cliente/du client
  // (nom, téléphone, courriel) — ne touche pas à la date/l'heure.
  // ------------------------------------------------------------------
  function wireEditButtons(container, onSaved) {
    container.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.edit;
        const panel = container.querySelector(`[data-edit-panel="${id}"]`);
        if (!panel) return;
        const wasOpen = !panel.classList.contains('hidden');
        // Ferme aussi les panneaux "Déplacer" ouverts, pour éviter d'avoir
        // deux panneaux ouverts en même temps sur la même rangée.
        container.querySelectorAll('.edit-panel, .move-panel').forEach((p) => p.classList.add('hidden'));
        if (wasOpen) return;
        panel.classList.remove('hidden');
        renderEditPanel(panel, id, onSaved);
      });
    });
  }

  function renderEditPanel(panel, apptId, onSaved) {
    const a = state.apptsById[apptId];
    if (!a) {
      panel.innerHTML = '<p class="empty-note">Rendez-vous introuvable — recharge la page.</p>';
      return;
    }

    panel.innerHTML = `
      <div class="grid2">
        <div>
          <label>Nom complet</label>
          <input type="text" class="edit-name-input" value="${escapeHtml(a.client_name)}" />
        </div>
        <div>
          <label>Téléphone</label>
          <input type="tel" class="edit-phone-input" value="${escapeHtml(a.client_phone)}" />
        </div>
      </div>
      <label>Courriel</label>
      <input type="email" class="edit-email-input" value="${escapeHtml(a.client_email)}" />
      <div class="edit-panel-error alert hidden"></div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button type="button" class="btn-small primary" data-edit-save="${apptId}">Enregistrer</button>
        <button type="button" class="btn-small" data-edit-close="${apptId}">Fermer</button>
      </div>
    `;

    panel.querySelector('[data-edit-close]').addEventListener('click', () => {
      panel.classList.add('hidden');
    });

    panel.querySelector('[data-edit-save]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const errBox = panel.querySelector('.edit-panel-error');
      errBox.classList.add('hidden');

      const client_name = panel.querySelector('.edit-name-input').value.trim();
      const client_phone = panel.querySelector('.edit-phone-input').value.trim();
      const client_email = panel.querySelector('.edit-email-input').value.trim();

      if (!client_name || !client_phone || !client_email) {
        errBox.textContent = 'Le nom, le téléphone et le courriel sont requis.';
        errBox.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      const { error } = await sb.from('appointments').update({ client_name, client_phone, client_email }).eq('id', apptId);
      btn.disabled = false;

      if (error) {
        errBox.textContent = error.message;
        errBox.classList.remove('hidden');
        return;
      }
      panel.classList.add('hidden');
      onSaved();
    });
  }

  // ------------------------------------------------------------------
  // Rendez-vous — vue Liste
  // ------------------------------------------------------------------
  el('show-all-toggle').addEventListener('change', loadAppointments);

  // ------------------------------------------------------------------
  // Rendez-vous — rangée d'aperçu (aujourd'hui / cette semaine / prochain)
  // ------------------------------------------------------------------
  function mondayOf(d) {
    const day = d.getDay(); // 0=dim .. 6=sam
    const diffToMonday = (day + 6) % 7;
    const m = new Date(d);
    m.setDate(d.getDate() - diffToMonday);
    return m;
  }

  async function loadApptStats() {
    const todayEl = el('stat-today');
    const weekEl = el('stat-week');
    const nextEl = el('stat-next');
    if (!todayEl || !weekEl || !nextEl) return;

    const today = todayISO();
    const monday = mondayOf(new Date());
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const weekStart = isoFromDate(monday);
    const weekEnd = isoFromDate(sunday);
    const empFilter = el('employee-filter').value;

    let qToday = sb.from('appointments').select('id', { count: 'exact', head: true }).eq('status', 'confirmed').eq('appt_date', today);
    let qWeek = sb.from('appointments').select('id', { count: 'exact', head: true }).eq('status', 'confirmed').gte('appt_date', weekStart).lte('appt_date', weekEnd);
    let qNext = sb.from('appointments').select('*').eq('status', 'confirmed').gte('appt_date', today)
      .order('appt_date', { ascending: true }).order('start_time', { ascending: true }).limit(10);
    if (empFilter) {
      qToday = qToday.eq('employee_id', empFilter);
      qWeek = qWeek.eq('employee_id', empFilter);
      qNext = qNext.eq('employee_id', empFilter);
    }

    const [todayRes, weekRes, nextRes] = await Promise.all([qToday, qWeek, qNext]);

    todayEl.textContent = todayRes.count ?? 0;
    weekEl.textContent = weekRes.count ?? 0;

    const nowHHMM = new Date().toTimeString().slice(0, 5);
    const upcoming = (nextRes.data || []).find((a) => a.appt_date > today || (a.appt_date === today && a.start_time >= nowHHMM));
    if (!upcoming) {
      nextEl.textContent = 'Aucun à venir';
    } else {
      const when = upcoming.appt_date === today ? `Aujourd'hui ${hhmm(upcoming.start_time)}` : `${humanDate(upcoming.appt_date)} ${hhmm(upcoming.start_time)}`;
      nextEl.textContent = `${when} — ${upcoming.client_name}${state.multiEmployee ? ` (${upcoming.employee_name})` : ''}`;
    }
  }

  async function loadAppointments() {
    loadApptStats();
    const list = el('appointments-list');
    list.innerHTML = '<p class="empty-note">Chargement…</p>';

    let query = sb.from('appointments').select('*').order('appt_date', { ascending: true }).order('start_time', { ascending: true });
    if (!el('show-all-toggle').checked) {
      query = query.gte('appt_date', todayISO());
    }
    const empFilter = el('employee-filter').value;
    if (empFilter) query = query.eq('employee_id', empFilter);

    const { data: appts, error } = await query;

    if (error) {
      list.innerHTML = `<p class="empty-note">Erreur : ${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!appts.length) {
      list.innerHTML = '<p class="empty-note">Aucun rendez-vous pour le moment.</p>';
      return;
    }

    const byDate = {};
    appts.forEach((a) => {
      byDate[a.appt_date] = byDate[a.appt_date] || [];
      byDate[a.appt_date].push(a);
    });

    const dates = Object.keys(byDate).sort();
    list.innerHTML = '';
    dates.forEach((date) => {
      const group = document.createElement('div');
      group.className = 'date-group';
      const h3 = document.createElement('h3');
      h3.textContent = humanDate(date);
      group.appendChild(h3);
      group.insertAdjacentHTML('beforeend', byDate[date].map(apptRowHTML).join(''));
      list.appendChild(group);
    });

    wireCancelButtons(list, loadAppointments);
    wireMoveButtons(list, loadAppointments);
    wireEditButtons(list, loadAppointments);
  }

  // ------------------------------------------------------------------
  // Rendez-vous — vue Calendrier
  // ------------------------------------------------------------------
  const calendarState = {
    month: startOfMonth(new Date()),
    selected: todayISO()
  };

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function isoFromDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Grille de 42 cases (6 semaines) commençant le lundi de la semaine du 1er du mois.
  function buildCalendarDays(monthDate) {
    const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const jsDay = firstOfMonth.getDay(); // 0=dim .. 6=sam
    const offsetToMonday = (jsDay + 6) % 7;
    const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1 - offsetToMonday);
    const days = [];
    for (let i = 0; i < 42; i++) {
      days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    }
    return days;
  }

  el('view-list-btn').addEventListener('click', () => switchApptView('list'));
  el('view-calendar-btn').addEventListener('click', () => switchApptView('calendar'));

  function switchApptView(view) {
    state.apptView = view;
    el('view-list-btn').classList.toggle('active', view === 'list');
    el('view-calendar-btn').classList.toggle('active', view === 'calendar');
    el('appointments-list-view').classList.toggle('hidden', view !== 'list');
    el('appointments-calendar-view').classList.toggle('hidden', view !== 'calendar');
    el('show-all-wrap').classList.toggle('hidden', view !== 'list');
    if (view === 'calendar') renderCalendar();
  }

  el('cal-prev-btn').addEventListener('click', () => {
    calendarState.month = new Date(calendarState.month.getFullYear(), calendarState.month.getMonth() - 1, 1);
    renderCalendar();
  });
  el('cal-next-btn').addEventListener('click', () => {
    calendarState.month = new Date(calendarState.month.getFullYear(), calendarState.month.getMonth() + 1, 1);
    renderCalendar();
  });
  el('cal-today-btn').addEventListener('click', () => {
    calendarState.month = startOfMonth(new Date());
    calendarState.selected = todayISO();
    renderCalendar();
  });

  async function renderCalendar() {
    loadApptStats();
    el('cal-month-label').textContent = calendarState.month.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' });

    const days = buildCalendarDays(calendarState.month);
    const rangeStart = isoFromDate(days[0]);
    const rangeEnd = isoFromDate(days[days.length - 1]);

    let query = sb
      .from('appointments')
      .select('appt_date, status')
      .gte('appt_date', rangeStart)
      .lte('appt_date', rangeEnd);
    const empFilter = el('employee-filter').value;
    if (empFilter) query = query.eq('employee_id', empFilter);
    const { data: appts } = await query;

    const counts = {};
    (appts || []).forEach((a) => {
      if (a.status !== 'confirmed') return;
      counts[a.appt_date] = (counts[a.appt_date] || 0) + 1;
    });

    const grid = el('calendar-grid');
    grid.innerHTML = '';
    ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].forEach((label) => {
      const h = document.createElement('div');
      h.className = 'calendar-weekday-header';
      h.textContent = label;
      grid.appendChild(h);
    });

    const today = todayISO();
    days.forEach((d) => {
      const iso = isoFromDate(d);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'calendar-day';
      if (d.getMonth() !== calendarState.month.getMonth()) cell.classList.add('other-month');
      if (iso === today) cell.classList.add('today');
      if (iso === calendarState.selected) cell.classList.add('selected');
      const count = counts[iso] || 0;
      cell.innerHTML = `
        <span class="day-num">${d.getDate()}</span>
        ${count > 0 ? `<span class="day-badge">${count}</span>` : ''}
      `;
      cell.addEventListener('click', () => {
        calendarState.selected = iso;
        renderCalendar();
      });
      grid.appendChild(cell);
    });

    await loadCalendarDayDetail(calendarState.selected);
  }

  async function loadCalendarDayDetail(dateStr) {
    const box = el('calendar-day-detail');
    box.innerHTML = `<h3>${humanDate(dateStr)}</h3><p class="empty-note">Chargement…</p>`;

    let query = sb
      .from('appointments')
      .select('*')
      .eq('appt_date', dateStr)
      .order('start_time', { ascending: true });
    const empFilter = el('employee-filter').value;
    if (empFilter) query = query.eq('employee_id', empFilter);
    const { data: appts, error } = await query;

    const heading = `<h3>${humanDate(dateStr)}</h3>`;
    if (error) {
      box.innerHTML = heading + `<p class="empty-note">Erreur : ${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!appts.length) {
      box.innerHTML = heading + '<p class="empty-note">Aucun rendez-vous ce jour-là.</p>';
      return;
    }
    box.innerHTML = heading + appts.map(apptRowHTML).join('');
    wireCancelButtons(box, () => renderCalendar());
    wireMoveButtons(box, () => renderCalendar());
    wireEditButtons(box, () => renderCalendar());
  }

  // ------------------------------------------------------------------
  // Services
  // ------------------------------------------------------------------
  el('add-service-btn').addEventListener('click', async () => {
    const name = el('new-svc-name').value.trim();
    const duration = Number(el('new-svc-duration').value);
    const priceStr = el('new-svc-price').value;
    const description = el('new-svc-desc').value.trim();

    if (!name || !duration || duration <= 0) {
      alert('Le nom et la durée sont requis.');
      return;
    }

    const btn = el('add-service-btn');
    btn.disabled = true;
    const { error } = await sb.from('services').insert({
      name,
      duration_minutes: duration,
      price_cents: priceStr ? Math.round(Number(priceStr) * 100) : null,
      description
    });
    btn.disabled = false;

    if (error) {
      alert(error.message);
      return;
    }
    el('new-svc-name').value = '';
    el('new-svc-duration').value = '';
    el('new-svc-price').value = '';
    el('new-svc-desc').value = '';
    await loadServices();
    if (state.isOwner) renderTeamList();
  });

  async function loadServices() {
    const list = el('services-list');
    list.innerHTML = '<p class="empty-note">Chargement…</p>';
    const { data: services, error } = await sb
      .from('services')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      list.innerHTML = `<p class="empty-note">Erreur : ${escapeHtml(error.message)}</p>`;
      return;
    }
    state.services = services || [];
    if (!services.length) {
      list.innerHTML = '<p class="empty-note">Aucun service. Ajoutes-en un ci-dessus.</p>';
      return;
    }
    list.innerHTML = '';
    services.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'service-row';
      row.innerHTML = `
        <div class="grid2">
          <div>
            <label>Nom</label>
            <input type="text" class="f-name" value="${escapeHtml(s.name)}" />
          </div>
          <div>
            <label>Durée (minutes)</label>
            <input type="number" class="f-duration" min="5" step="5" value="${s.duration_minutes}" />
          </div>
        </div>
        <div class="grid2">
          <div>
            <label>Prix ($)</label>
            <input type="number" class="f-price" min="0" step="0.01" value="${s.price_cents != null ? (s.price_cents / 100).toFixed(2) : ''}" />
          </div>
          <div>
            <label>Description</label>
            <input type="text" class="f-desc" value="${escapeHtml(s.description || '')}" />
          </div>
        </div>
        <div class="checkbox-line">
          <input type="checkbox" class="f-active" id="active-${s.id}" ${s.active ? 'checked' : ''} />
          <label for="active-${s.id}">Actif (visible pour les clients)</label>
        </div>
        <div class="row-actions">
          <button class="btn-small danger" data-delete="${s.id}">Supprimer</button>
          <button class="btn-small primary" data-save="${s.id}">Enregistrer</button>
        </div>
      `;
      list.appendChild(row);

      row.querySelector('[data-save]').addEventListener('click', async () => {
        const btn = row.querySelector('[data-save]');
        btn.disabled = true;
        const priceStr = row.querySelector('.f-price').value;
        const { error } = await sb.from('services').update({
          name: row.querySelector('.f-name').value.trim(),
          duration_minutes: Number(row.querySelector('.f-duration').value),
          price_cents: priceStr ? Math.round(Number(priceStr) * 100) : null,
          description: row.querySelector('.f-desc').value.trim(),
          active: row.querySelector('.f-active').checked
        }).eq('id', s.id);
        btn.disabled = false;
        if (error) {
          alert(error.message);
          return;
        }
        btn.textContent = 'Enregistré !';
        setTimeout(() => (btn.textContent = 'Enregistrer'), 1200);
        state.services = state.services.map((x) => (x.id === s.id ? { ...x, name: row.querySelector('.f-name').value.trim() } : x));
      });

      row.querySelector('[data-delete]').addEventListener('click', async () => {
        if (!confirm(`Supprimer le service "${s.name}" ? Les rendez-vous déjà pris seront conservés.`)) return;
        const { error } = await sb.from('services').delete().eq('id', s.id);
        if (error) {
          alert(error.message);
          return;
        }
        await loadServices();
        if (state.isOwner) renderTeamList();
      });
    });
  }

  // ------------------------------------------------------------------
  // Horaire / réglages généraux (propriétaire)
  // ------------------------------------------------------------------
  async function loadSettings() {
    const { data: s, error } = await sb.from('business_settings').select('*').eq('id', true).single();
    if (error || !s) return;

    el('setting-biz-name').value = s.business_name;
    el('setting-timezone').value = s.timezone;
    el('setting-interval').value = s.slot_interval_minutes;
    el('setting-buffer').value = s.buffer_minutes;
    el('setting-notice').value = s.min_notice_hours;
    el('setting-advance').value = s.max_advance_days;

    buildHoursRows(el('hours-list'), s.business_hours);
    if (state.isOwner) loadClosedDates();
  }

  el('save-settings-btn').addEventListener('click', async () => {
    const btn = el('save-settings-btn');
    const note = el('settings-save-note');
    const bizName = el('setting-biz-name').value.trim();

    if (!bizName) {
      alert('Le nom de la business ne peut pas être vide.');
      return;
    }

    btn.disabled = true;

    const { error } = await sb.from('business_settings').update({
      business_name: bizName,
      timezone: el('setting-timezone').value.trim(),
      slot_interval_minutes: Number(el('setting-interval').value) || 15,
      buffer_minutes: Number(el('setting-buffer').value) || 0,
      min_notice_hours: Number(el('setting-notice').value) || 0,
      max_advance_days: Number(el('setting-advance').value) || 30
    }).eq('id', true);

    btn.disabled = false;

    if (error) {
      note.textContent = '';
      alert(error.message);
      return;
    }
    note.textContent = 'Réglages enregistrés.';
    loadBusinessName();
    setTimeout(() => (note.textContent = ''), 2500);
  });

  el('save-hours-btn').addEventListener('click', async () => {
    const btn = el('save-hours-btn');
    const note = el('hours-save-note');
    btn.disabled = true;

    const business_hours = readHoursRows(el('hours-list'));

    const { error } = await sb.from('business_settings').update({ business_hours }).eq('id', true);

    if (!error) {
      // Tant qu'il n'y a pas d'équipe, l'horaire général EST l'horaire du/de
      // la propriétaire — on le garde synchronisé pour ne rien avoir de
      // plus à gérer en mode solo. Dès qu'un(e) employé(e) est ajouté(e),
      // cette synchro automatique s'arrête (chacun·e gère son horaire).
      const activeCount = state.employees.filter((e) => e.active).length;
      if (state.isOwner && activeCount <= 1 && state.myEmployee) {
        await sb.from('employees').update({ hours: business_hours }).eq('id', state.myEmployee.id);
      }
    }

    btn.disabled = false;

    if (error) {
      note.textContent = '';
      alert(error.message);
      return;
    }
    note.textContent = 'Horaire enregistré.';
    setTimeout(() => (note.textContent = ''), 2500);
  });

  // ------------------------------------------------------------------
  // Jours fériés / fermetures ponctuelles (propriétaire)
  // ------------------------------------------------------------------
  async function loadClosedDates() {
    const list = el('closed-dates-list');
    if (!list) return;
    list.innerHTML = '<p class="empty-note">Chargement…</p>';

    const { data: rows, error } = await sb
      .from('closed_dates')
      .select('*')
      .gte('closed_date', todayISO())
      .order('closed_date', { ascending: true });

    if (error) {
      list.innerHTML = `<p class="empty-note">Erreur : ${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<p class="empty-note">Aucune fermeture programmée.</p>';
      return;
    }

    list.innerHTML = rows.map((r) => `
      <div class="day-row" data-closed-row="${r.closed_date}">
        <div class="day-name" style="width:auto; min-width:140px;">${humanDate(r.closed_date)}</div>
        <div style="flex:1; color:var(--ink-soft); font-size:0.9rem;">${r.label ? escapeHtml(r.label) : ''}</div>
        <button class="btn-small danger" data-remove-closed="${r.closed_date}">Retirer</button>
      </div>
    `).join('');

    list.querySelectorAll('[data-remove-closed]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Retirer cette fermeture ? Le jour redevient réservable selon l\'horaire habituel.')) return;
        btn.disabled = true;
        const { error: delErr } = await sb.from('closed_dates').delete().eq('closed_date', btn.dataset.removeClosed);
        if (delErr) {
          alert(delErr.message);
          btn.disabled = false;
          return;
        }
        loadClosedDates();
      });
    });
  }

  el('add-closed-date-btn').addEventListener('click', async () => {
    const dateInput = el('new-closed-date');
    const labelInput = el('new-closed-label');
    const warningBox = el('closed-date-warning');
    warningBox.classList.add('hidden');

    const date = dateInput.value;
    if (!date) {
      alert('Choisis une date.');
      return;
    }

    const btn = el('add-closed-date-btn');
    btn.disabled = true;

    const { error } = await sb.from('closed_dates').insert({
      closed_date: date,
      label: labelInput.value.trim() || null
    });

    if (error) {
      btn.disabled = false;
      alert(error.code === '23505' ? 'Cette date est déjà marquée comme fermée.' : error.message);
      return;
    }

    // Avertit si des rendez-vous confirmés existent déjà ce jour-là — la
    // fermeture n'annule rien automatiquement, il faut les déplacer/annuler
    // soi-même (onglet Rendez-vous) si besoin.
    const { count } = await sb
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('appt_date', date)
      .eq('status', 'confirmed');

    btn.disabled = false;
    dateInput.value = '';
    labelInput.value = '';

    if (count && count > 0) {
      warningBox.textContent = `Attention : ${count} rendez-vous ${count > 1 ? 'sont' : 'est'} déjà confirmé${count > 1 ? 's' : ''} ce jour-là. La fermeture n'annule rien automatiquement — utilise Déplacer ou Annuler dans l'onglet Rendez-vous au besoin.`;
      warningBox.classList.remove('hidden');
    }

    loadClosedDates();
  });

  // ------------------------------------------------------------------
  // Mon horaire (employé(e) non-propriétaire)
  // ------------------------------------------------------------------
  el('save-my-hours-btn').addEventListener('click', async () => {
    const btn = el('save-my-hours-btn');
    const note = el('hours-mine-save-note');
    btn.disabled = true;

    const hours = readHoursRows(el('hours-mine-list'));
    const { error } = await sb.rpc('update_my_employee_profile', { p_full_name: null, p_phone: null, p_hours: hours });

    btn.disabled = false;
    if (error) {
      note.textContent = '';
      alert(error.message);
      return;
    }
    note.textContent = 'Horaire enregistré.';
    setTimeout(() => (note.textContent = ''), 2500);
  });

  // ------------------------------------------------------------------
  // Compte
  // ------------------------------------------------------------------
  el('change-pwd-btn').addEventListener('click', async () => {
    const np = el('pwd-new').value;
    const cp = el('pwd-confirm').value;
    const errBox = el('pwd-error');
    const note = el('pwd-note');
    errBox.classList.add('hidden');
    note.textContent = '';

    if (np.length < 6) {
      errBox.textContent = 'Le mot de passe doit contenir au moins 6 caractères.';
      errBox.classList.remove('hidden');
      return;
    }
    if (np !== cp) {
      errBox.textContent = 'Les deux mots de passe ne correspondent pas.';
      errBox.classList.remove('hidden');
      return;
    }

    const btn = el('change-pwd-btn');
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: np });
    btn.disabled = false;

    if (error) {
      errBox.textContent = error.message;
      errBox.classList.remove('hidden');
      return;
    }
    note.textContent = 'Mot de passe mis à jour.';
    el('pwd-new').value = '';
    el('pwd-confirm').value = '';
  });

  el('save-my-name-btn').addEventListener('click', async () => {
    const note = el('my-name-note');
    const name = el('my-name-input').value.trim();
    note.textContent = '';
    if (!name) {
      alert('Le nom ne peut pas être vide.');
      return;
    }
    const btn = el('save-my-name-btn');
    btn.disabled = true;
    const { error } = await sb.rpc('update_my_employee_profile', { p_full_name: name, p_phone: null, p_hours: null });
    btn.disabled = false;
    if (error) {
      alert(error.message);
      return;
    }
    note.textContent = 'Nom mis à jour.';
    setTimeout(() => (note.textContent = ''), 2000);
    loadTeamAndRole();
  });

  // ------------------------------------------------------------------
  // Ma photo (onglet Compte) — chacun·e (propriétaire ou employé(e))
  // change SA PROPRE photo ici. Le/la propriétaire peut en plus changer
  // celle de n'importe qui depuis l'onglet Équipe.
  // ------------------------------------------------------------------
  function renderMyPhoto() {
    if (!state.myEmployee) return;
    el('my-photo-avatar').innerHTML = avatarHTML(state.myEmployee, 'lg');
    el('my-photo-remove').classList.toggle('hidden', !state.myEmployee.photo_url);
  }

  el('my-photo-trigger').addEventListener('click', () => el('my-photo-input').click());

  el('my-photo-input').addEventListener('change', async () => {
    const input = el('my-photo-input');
    const note = el('my-photo-note');
    const file = input.files[0];
    input.value = '';
    if (!file || !state.myEmployee) return;
    note.textContent = 'Téléversement…';
    try {
      const url = await uploadEmployeePhoto(file, state.myEmployee.id);
      const { error } = await sb.rpc('update_my_employee_profile', {
        p_full_name: null, p_phone: null, p_hours: null, p_photo_url: url, p_clear_photo: false
      });
      if (error) throw error;
      state.myEmployee.photo_url = url;
      renderMyPhoto();
      note.textContent = 'Photo mise à jour.';
      setTimeout(() => (note.textContent = ''), 2000);
    } catch (err) {
      note.textContent = err.message || 'Erreur lors du téléversement.';
    }
  });

  el('my-photo-remove').addEventListener('click', async () => {
    if (!state.myEmployee) return;
    if (!confirm('Retirer ta photo ?')) return;
    const { error } = await sb.rpc('update_my_employee_profile', {
      p_full_name: null, p_phone: null, p_hours: null, p_photo_url: null, p_clear_photo: true
    });
    if (error) {
      alert(error.message);
      return;
    }
    state.myEmployee.photo_url = null;
    renderMyPhoto();
  });

  // ------------------------------------------------------------------
  // Mes services offerts (onglet Compte) — un(e) employé(e) coche
  // elle-même quels services (parmi le catalogue existant) elle offre.
  // Le catalogue lui-même (créer/modifier un service) reste réservé
  // au/à la propriétaire, dans l'onglet Services.
  // ------------------------------------------------------------------
  function renderMyServices() {
    const wrap = el('my-services-list');
    if (!state.myEmployee) return;
    if (!state.services.length) {
      wrap.innerHTML = '<p class="empty-note">Aucun service actif pour le moment — demande à la/le propriétaire d\'en ajouter dans l\'onglet Services.</p>';
      return;
    }
    wrap.innerHTML = state.services.map((s) => `
      <label class="checkbox-line svc-check">
        <input type="checkbox" class="my-svc" value="${s.id}" ${state.myEmployee.serviceIds?.has(s.id) ? 'checked' : ''} />
        ${escapeHtml(s.name)}
      </label>
    `).join('');
  }

  el('save-my-services-btn').addEventListener('click', async () => {
    if (!state.myEmployee) return;
    const btn = el('save-my-services-btn');
    const note = el('my-services-note');
    btn.disabled = true;
    note.textContent = '';

    const selectedIds = Array.from(el('my-services-list').querySelectorAll('.my-svc:checked')).map((cb) => cb.value);

    const { error: delErr } = await sb.from('employee_services').delete().eq('employee_id', state.myEmployee.id);
    if (delErr) {
      btn.disabled = false;
      alert(delErr.message);
      return;
    }
    if (selectedIds.length) {
      const { error: insErr } = await sb.from('employee_services').insert(
        selectedIds.map((sid) => ({ employee_id: state.myEmployee.id, service_id: sid }))
      );
      if (insErr) {
        btn.disabled = false;
        alert(insErr.message);
        return;
      }
    }

    btn.disabled = false;
    note.textContent = 'Enregistré !';
    setTimeout(() => (note.textContent = ''), 2000);
    loadTeamAndRole();
  });

  // ------------------------------------------------------------------
  checkSession();
})();
