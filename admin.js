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
  // Auth
  // ------------------------------------------------------------------
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
    await loadBusinessName();
    loadAppointments();
    loadServices();
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
  // ou invitation), Supabase déclenche cet évènement avec une session valide.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session) {
      showApp(session.user);
      document.querySelector('[data-tab="account"]').click();
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
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      el(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  // ------------------------------------------------------------------
  // Rendez-vous — helpers partagés entre la vue Liste et la vue Calendrier
  // ------------------------------------------------------------------
  function apptRowHTML(a) {
    return `
      <div class="appt-row">
        <div class="time">${hhmm(a.start_time)} – ${hhmm(a.end_time)}</div>
        <div class="info">
          <div class="service">${escapeHtml(a.service_name)}</div>
          <div class="client">${escapeHtml(a.client_name)} · ${escapeHtml(a.client_phone)} · ${escapeHtml(a.client_email)}</div>
        </div>
        <span class="badge ${a.status}">${a.status === 'cancelled' ? 'Annulé' : 'Confirmé'}</span>
        ${a.status !== 'cancelled' ? `<button class="btn-small danger" data-cancel="${a.id}">Annuler</button>` : ''}
      </div>
    `;
  }

  function wireCancelButtons(container, onCancelled) {
    container.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Annuler ce rendez-vous ?')) return;
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
  // Rendez-vous — vue Liste
  // ------------------------------------------------------------------
  el('show-all-toggle').addEventListener('change', loadAppointments);

  async function loadAppointments() {
    const list = el('appointments-list');
    list.innerHTML = '<p class="empty-note">Chargement…</p>';

    let query = sb.from('appointments').select('*').order('appt_date', { ascending: true }).order('start_time', { ascending: true });
    if (!el('show-all-toggle').checked) {
      query = query.gte('appt_date', todayISO());
    }
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
    el('cal-month-label').textContent = calendarState.month.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' });

    const days = buildCalendarDays(calendarState.month);
    const rangeStart = isoFromDate(days[0]);
    const rangeEnd = isoFromDate(days[days.length - 1]);

    const { data: appts } = await sb
      .from('appointments')
      .select('appt_date, status')
      .gte('appt_date', rangeStart)
      .lte('appt_date', rangeEnd);

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

    const { data: appts, error } = await sb
      .from('appointments')
      .select('*')
      .eq('appt_date', dateStr)
      .order('start_time', { ascending: true });

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
    loadServices();
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
      });

      row.querySelector('[data-delete]').addEventListener('click', async () => {
        if (!confirm(`Supprimer le service "${s.name}" ? Les rendez-vous déjà pris seront conservés.`)) return;
        const { error } = await sb.from('services').delete().eq('id', s.id);
        if (error) {
          alert(error.message);
          return;
        }
        loadServices();
      });
    });
  }

  // ------------------------------------------------------------------
  // Horaire / réglages
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

    const hoursList = el('hours-list');
    hoursList.innerHTML = '';
    DAY_KEYS.forEach((day) => {
      const h = s.business_hours[day] || { closed: true, open: '09:00', close: '17:00' };
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
      hoursList.appendChild(row);

      row.querySelector('.f-closed').addEventListener('change', (e) => {
        const closed = e.target.checked;
        row.querySelector('.day-times').style.opacity = closed ? '.4' : '1';
        row.querySelector('.f-open').disabled = closed;
        row.querySelector('.f-close').disabled = closed;
      });
    });
  }

  el('save-hours-btn').addEventListener('click', async () => {
    const btn = el('save-hours-btn');
    const note = el('hours-save-note');
    btn.disabled = true;

    const business_hours = {};
    document.querySelectorAll('#hours-list .day-row').forEach((row) => {
      const day = row.dataset.day;
      business_hours[day] = {
        closed: row.querySelector('.f-closed').checked,
        open: row.querySelector('.f-open').value || '09:00',
        close: row.querySelector('.f-close').value || '17:00'
      };
    });

    const { error } = await sb.from('business_settings').update({
      business_name: el('setting-biz-name').value.trim(),
      timezone: el('setting-timezone').value.trim(),
      slot_interval_minutes: Number(el('setting-interval').value) || 15,
      buffer_minutes: Number(el('setting-buffer').value) || 0,
      min_notice_hours: Number(el('setting-notice').value) || 0,
      max_advance_days: Number(el('setting-advance').value) || 30,
      business_hours
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

  // ------------------------------------------------------------------
  checkSession();
})();
