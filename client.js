/* ============================================================
   Rendez-vous — page client (réservation publique)
   ============================================================ */

const { createClient } = supabase;
const sb = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

(() => {
  const state = {
    business: null,
    employees: [],
    multiEmployee: false,
    steps: ['service', 'time', 'info', 'done'], // recalculé une fois les employé(e)s chargé(e)s
    services: [],
    selectedEmployee: null,
    selectedServiceIds: new Set(), // choix en cours à l'étape "service" (plusieurs services possibles, back-to-back)
    selectedServices: [],          // figé une fois "Continuer" cliqué — utilisé pour les étapes suivantes
    selectedDate: null,
    selectedSlot: null
  };

  const el = (id) => document.getElementById(id);

  function renderDots() {
    const wrap = el('steps-dots');
    wrap.innerHTML = '';
    state.steps.forEach((_, i) => {
      const d = document.createElement('div');
      d.className = 'dot';
      d.dataset.step = String(i + 1);
      wrap.appendChild(d);
    });
  }

  function setStep(name) {
    const idx = state.steps.indexOf(name);
    document.querySelectorAll('.steps .dot').forEach((d) => {
      d.classList.toggle('active', Number(d.dataset.step) <= idx + 1);
    });
    el('step-employee').classList.toggle('hidden', name !== 'employee');
    el('step-service').classList.toggle('hidden', name !== 'service');
    el('step-time').classList.toggle('hidden', name !== 'time');
    el('step-info').classList.toggle('hidden', name !== 'info');
    el('step-done').classList.toggle('hidden', name !== 'done');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function money(cents) {
    if (cents === null || cents === undefined) return '';
    return (cents / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
  }

  function humanDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('fr-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function addDaysISO(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  function initials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0][0] || '';
    const second = parts.length > 1 ? parts[1][0] : '';
    return (first + second).toUpperCase();
  }

  function avatarHTML(emp) {
    if (emp.photo_url) {
      return `<img class="avatar" src="${escapeHtml(emp.photo_url)}" alt="" />`;
    }
    return `<div class="avatar">${escapeHtml(initials(emp.full_name))}</div>`;
  }

  // Enlève les secondes que Postgres ajoute aux "time" (ex. "10:00:00" -> "10:00")
  function hhmm(t) {
    return t ? t.slice(0, 5) : t;
  }

  async function loadBusiness() {
    const { data, error } = await sb
      .from('business_settings')
      .select('business_name, max_advance_days')
      .eq('id', true)
      .single();
    if (error || !data) {
      el('biz-name').textContent = 'Prise de rendez-vous';
      state.business = { name: 'Mon salon', maxAdvanceDays: 45 };
      return;
    }
    state.business = { name: data.business_name, maxAdvanceDays: data.max_advance_days };
    el('biz-name').textContent = state.business.name;
    document.title = `Rendez-vous — ${state.business.name}`;
  }

  // ------------------------------------------------------------------
  // Étape : choix de la spécialiste (sautée automatiquement s'il n'y en
  // a qu'une seule — comportement identique à l'ancienne version solo).
  // ------------------------------------------------------------------
  async function loadEmployees() {
    const wrap = el('employee-list');
    const { data, error } = await sb
      .from('employees')
      .select('id, full_name, photo_url')
      .eq('active', true)
      .order('full_name', { ascending: true });

    if (error || !data || !data.length) {
      wrap.innerHTML = '<p class="empty-note">Aucun membre de l\'équipe disponible pour le moment.</p>';
      state.employees = [];
      state.multiEmployee = false;
      state.steps = ['service', 'time', 'info', 'done'];
      renderDots();
      return;
    }

    state.employees = data;
    state.multiEmployee = data.length > 1;

    if (!state.multiEmployee) {
      // Une seule personne dans l'équipe : on saute directement à l'étape service.
      state.steps = ['service', 'time', 'info', 'done'];
      renderDots();
      selectEmployee(data[0], { silent: true });
      return;
    }

    state.steps = ['employee', 'service', 'time', 'info', 'done'];
    renderDots();

    wrap.innerHTML = '';
    data.forEach((emp) => {
      const btn = document.createElement('button');
      btn.className = 'service-card';
      btn.type = 'button';
      btn.innerHTML = `${avatarHTML(emp)}<div><div class="name">${escapeHtml(emp.full_name)}</div></div><div class="chevron">&rarr;</div>`;
      btn.addEventListener('click', () => selectEmployee(emp));
      wrap.appendChild(btn);
    });

    setStep('employee');
  }

  function selectEmployee(emp, opts) {
    state.selectedEmployee = emp;
    state.selectedServiceIds = new Set();
    state.selectedServices = [];
    document.querySelector('[data-back="employee"]').classList.toggle('hidden', !state.multiEmployee);
    el('service-title').textContent = state.multiEmployee
      ? `Choisis un ou plusieurs services — avec ${emp.full_name}`
      : 'Choisis un ou plusieurs services';
    loadServices();
    if (!(opts && opts.silent)) setStep('service');
  }

  // ------------------------------------------------------------------
  // Étape : choix du/des service(s) (filtré selon la spécialiste choisie)
  // — plusieurs services peuvent être cochés pour une visite back-to-back
  //   (ex. coupe + couleur), réservés ensemble comme un seul rendez-vous.
  // ------------------------------------------------------------------
  async function loadServices() {
    const wrap = el('service-list');
    wrap.innerHTML = '<p class="empty-note">Chargement des services…</p>';
    state.selectedServiceIds = new Set();

    const { data, error } = await sb
      .from('employee_services')
      .select('service_id, services!inner(id, name, duration_minutes, price_cents, description, sort_order)')
      .eq('employee_id', state.selectedEmployee.id);

    const services = (error || !data) ? [] : data.map((row) => row.services)
      .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

    if (!services.length) {
      wrap.innerHTML = '<p class="empty-note">Aucun service disponible pour le moment.</p>';
      updateServiceSummary();
      return;
    }
    state.services = services;
    wrap.innerHTML = '';
    services.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'service-card';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="check-indicator"></span>
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="meta">${s.duration_minutes} min${s.description ? ' · ' + escapeHtml(s.description) : ''}</div>
        </div>
        <div class="price">${money(s.price_cents)}</div>
      `;
      btn.addEventListener('click', () => toggleServiceSelection(s, btn));
      wrap.appendChild(btn);
    });

    updateServiceSummary();
    setStep('service');
  }

  function toggleServiceSelection(service, cardEl) {
    if (state.selectedServiceIds.has(service.id)) {
      state.selectedServiceIds.delete(service.id);
      cardEl.classList.remove('selected');
    } else {
      state.selectedServiceIds.add(service.id);
      cardEl.classList.add('selected');
    }
    updateServiceSummary();
  }

  function updateServiceSummary() {
    const bar = el('service-summary');
    const continueBtn = el('services-continue-btn');
    const selected = state.services.filter((s) => state.selectedServiceIds.has(s.id));

    if (!selected.length) {
      bar.classList.add('hidden');
      continueBtn.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    continueBtn.classList.remove('hidden');

    const totalMinutes = selected.reduce((sum, s) => sum + s.duration_minutes, 0);
    const totalPrice = selected.every((s) => s.price_cents != null)
      ? selected.reduce((sum, s) => sum + s.price_cents, 0)
      : null;

    el('service-summary-count').textContent = selected.length === 1
      ? `1 service · ${totalMinutes} min`
      : `${selected.length} services · ${totalMinutes} min au total`;
    el('service-summary-price').textContent = totalPrice != null ? money(totalPrice) : '';
  }

  el('services-continue-btn').addEventListener('click', () => {
    const selected = state.services.filter((s) => state.selectedServiceIds.has(s.id));
    if (!selected.length) return;
    selectServices(selected);
  });

  function selectServices(services) {
    state.selectedServices = services;
    state.selectedSlot = null;
    const label = services.length === 1 ? services[0].name : `${services.length} services`;
    el('time-title').textContent = `Choisis une date et une heure — ${label}`;

    const dateInput = el('date-input');
    const min = todayISO();
    const max = addDaysISO(min, (state.business && state.business.maxAdvanceDays) || 45);
    dateInput.min = min;
    dateInput.max = max;
    dateInput.value = min;
    state.selectedDate = min;

    setStep('time');
    loadSlots();
  }

  async function loadSlots() {
    const grid = el('slots-grid');
    const note = el('slots-note');
    grid.innerHTML = '';
    note.textContent = 'Chargement des disponibilités…';
    note.classList.remove('hidden');

    if (!state.selectedServices.length || !state.selectedDate || !state.selectedEmployee) return;

    const { data, error } = state.selectedServices.length === 1
      ? await sb.rpc('get_available_slots', {
          p_service_id: state.selectedServices[0].id,
          p_employee_id: state.selectedEmployee.id,
          p_date: state.selectedDate
        })
      : await sb.rpc('get_available_slots_for_services', {
          p_service_ids: state.selectedServices.map((s) => s.id),
          p_employee_id: state.selectedEmployee.id,
          p_date: state.selectedDate
        });

    const slots = error || !data ? [] : data;

    if (!slots.length) {
      note.textContent = "Aucune disponibilité ce jour-là. Essaie une autre date.";
      return;
    }
    note.classList.add('hidden');
    slots.forEach((slot) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.textContent = hhmm(slot.start_time);
      btn.addEventListener('click', () => {
        state.selectedSlot = { start: hhmm(slot.start_time), end: hhmm(slot.end_time) };
        goToInfoStep();
      });
      grid.appendChild(btn);
    });
  }

  function goToInfoStep() {
    const services = state.selectedServices;
    const slot = state.selectedSlot;
    const totalPrice = services.every((s) => s.price_cents != null)
      ? services.reduce((sum, s) => sum + s.price_cents, 0)
      : null;
    el('recap-box').innerHTML = `
      ${state.multiEmployee ? `<div class="row"><span>Avec</span><span>${escapeHtml(state.selectedEmployee.full_name)}</span></div>` : ''}
      <div class="row"><span>${services.length > 1 ? 'Services' : 'Service'}</span><span>${escapeHtml(services.map((s) => s.name).join(', '))}</span></div>
      <div class="row"><span>Date</span><span>${humanDate(state.selectedDate)}</span></div>
      <div class="row"><span>Heure</span><span>${slot.start} – ${slot.end}</span></div>
      ${totalPrice != null ? `<div class="row"><span>Prix</span><span>${money(totalPrice)}</span></div>` : ''}
    `;
    el('form-error').classList.add('hidden');
    setStep('info');
  }

  async function submitAppointment() {
    const name = el('name-input').value.trim();
    const phone = el('phone-input').value.trim();
    const email = el('email-input').value.trim();
    const errBox = el('form-error');

    if (!name || !phone || !email) {
      errBox.textContent = 'Merci de remplir tous les champs.';
      errBox.classList.remove('hidden');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errBox.textContent = 'Courriel invalide.';
      errBox.classList.remove('hidden');
      return;
    }

    const btn = el('confirm-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Confirmation…';

    const { data, error } = state.selectedServices.length === 1
      ? await sb.rpc('book_appointment', {
          p_service_id: state.selectedServices[0].id,
          p_employee_id: state.selectedEmployee.id,
          p_date: state.selectedDate,
          p_start_time: state.selectedSlot.start,
          p_client_name: name,
          p_client_phone: phone,
          p_client_email: email
        })
      : await sb.rpc('book_multi_service_appointment', {
          p_service_ids: state.selectedServices.map((s) => s.id),
          p_employee_id: state.selectedEmployee.id,
          p_date: state.selectedDate,
          p_start_time: state.selectedSlot.start,
          p_client_name: name,
          p_client_phone: phone,
          p_client_email: email
        });

    if (error) {
      const code = error.message || '';
      if (code.includes('SLOT_UNAVAILABLE')) {
        errBox.textContent = "Ce créneau vient d'être pris. Merci de choisir une autre heure.";
        errBox.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Confirmer le rendez-vous';
        setTimeout(() => {
          setStep('time');
          loadSlots();
        }, 1500);
        return;
      }
      errBox.textContent = "Une erreur est survenue. Réessaie.";
      errBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Confirmer le rendez-vous';
      return;
    }

    const appts = Array.isArray(data) ? data : [data];
    const first = appts[0];
    const last = appts[appts.length - 1];
    el('done-recap').innerHTML = `
      ${state.multiEmployee ? `<div class="row"><span>Avec</span><span>${escapeHtml(first.employee_name)}</span></div>` : ''}
      <div class="row"><span>${appts.length > 1 ? 'Services' : 'Service'}</span><span>${escapeHtml(appts.map((a) => a.service_name).join(', '))}</span></div>
      <div class="row"><span>Date</span><span>${humanDate(first.appt_date)}</span></div>
      <div class="row"><span>Heure</span><span>${hhmm(first.start_time)} – ${hhmm(last.end_time)}</span></div>
    `;

    const linksWrap = el('manage-appt-links');
    const withToken = appts.filter((a) => a.manage_token);
    if (!withToken.length) {
      linksWrap.innerHTML = '';
    } else if (appts.length === 1) {
      linksWrap.innerHTML = `<a href="manage.html?token=${withToken[0].manage_token}" class="btn">Gérer mon rendez-vous</a>`;
    } else {
      linksWrap.innerHTML = `
        <p class="empty-note" style="padding-top:0;">Chaque service peut être géré (déplacé/annulé) individuellement :</p>
        <div class="manage-links-list">
          ${withToken.map((a) => `<a href="manage.html?token=${a.manage_token}" class="btn secondary manage-link-item">${escapeHtml(a.service_name)}</a>`).join('')}
        </div>
      `;
    }

    btn.disabled = false;
    btn.textContent = 'Confirmer le rendez-vous';
    setStep('done');
  }

  function resetFlow() {
    state.selectedServiceIds = new Set();
    state.selectedServices = [];
    state.selectedDate = null;
    state.selectedSlot = null;
    document.querySelectorAll('#service-list .service-card.selected').forEach((c) => c.classList.remove('selected'));
    updateServiceSummary();
    el('name-input').value = '';
    el('phone-input').value = '';
    el('email-input').value = '';
    if (state.multiEmployee) {
      state.selectedEmployee = null;
      setStep('employee');
    } else {
      setStep('service');
    }
  }

  el('date-input').addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    loadSlots();
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.back;
      if (target === 'employee') setStep('employee');
      if (target === 'service') setStep('service');
      if (target === 'time') setStep('time');
    });
  });

  el('confirm-btn').addEventListener('click', submitAppointment);
  el('new-appt-btn').addEventListener('click', resetFlow);

  loadBusiness();
  loadEmployees();
})();
