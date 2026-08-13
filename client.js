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
    selectedService: null,
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
      .select('id, full_name')
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
      btn.innerHTML = `<div><div class="name">${escapeHtml(emp.full_name)}</div></div><div class="chevron">&rarr;</div>`;
      btn.addEventListener('click', () => selectEmployee(emp));
      wrap.appendChild(btn);
    });

    setStep('employee');
  }

  function selectEmployee(emp, opts) {
    state.selectedEmployee = emp;
    state.selectedService = null;
    document.querySelector('[data-back="employee"]').classList.toggle('hidden', !state.multiEmployee);
    el('service-title').textContent = state.multiEmployee
      ? `Choisis ton service — avec ${emp.full_name}`
      : 'Choisis ton service';
    loadServices();
    if (!(opts && opts.silent)) setStep('service');
  }

  // ------------------------------------------------------------------
  // Étape : choix du service (filtré selon la spécialiste choisie)
  // ------------------------------------------------------------------
  async function loadServices() {
    const wrap = el('service-list');
    wrap.innerHTML = '<p class="empty-note">Chargement des services…</p>';

    const { data, error } = await sb
      .from('employee_services')
      .select('service_id, services!inner(id, name, duration_minutes, price_cents, description, sort_order)')
      .eq('employee_id', state.selectedEmployee.id);

    const services = (error || !data) ? [] : data.map((row) => row.services)
      .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

    if (!services.length) {
      wrap.innerHTML = '<p class="empty-note">Aucun service disponible pour le moment.</p>';
      return;
    }
    state.services = services;
    wrap.innerHTML = '';
    services.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'service-card';
      btn.type = 'button';
      btn.innerHTML = `
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="meta">${s.duration_minutes} min${s.description ? ' · ' + escapeHtml(s.description) : ''}</div>
        </div>
        <div class="price">${money(s.price_cents)}</div>
      `;
      btn.addEventListener('click', () => selectService(s));
      wrap.appendChild(btn);
    });

    setStep('service');
  }

  function selectService(service) {
    state.selectedService = service;
    state.selectedSlot = null;
    el('time-title').textContent = `Choisis une date et une heure — ${service.name}`;

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

    if (!state.selectedService || !state.selectedDate || !state.selectedEmployee) return;

    const { data, error } = await sb.rpc('get_available_slots', {
      p_service_id: state.selectedService.id,
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
    const s = state.selectedService;
    const slot = state.selectedSlot;
    el('recap-box').innerHTML = `
      ${state.multiEmployee ? `<div class="row"><span>Avec</span><span>${escapeHtml(state.selectedEmployee.full_name)}</span></div>` : ''}
      <div class="row"><span>Service</span><span>${escapeHtml(s.name)}</span></div>
      <div class="row"><span>Date</span><span>${humanDate(state.selectedDate)}</span></div>
      <div class="row"><span>Heure</span><span>${slot.start} – ${slot.end}</span></div>
      ${s.price_cents != null ? `<div class="row"><span>Prix</span><span>${money(s.price_cents)}</span></div>` : ''}
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

    const { data, error } = await sb.rpc('book_appointment', {
      p_service_id: state.selectedService.id,
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

    const appt = Array.isArray(data) ? data[0] : data;
    el('done-recap').innerHTML = `
      ${state.multiEmployee ? `<div class="row"><span>Avec</span><span>${escapeHtml(appt.employee_name)}</span></div>` : ''}
      <div class="row"><span>Service</span><span>${escapeHtml(appt.service_name)}</span></div>
      <div class="row"><span>Date</span><span>${humanDate(appt.appt_date)}</span></div>
      <div class="row"><span>Heure</span><span>${hhmm(appt.start_time)} – ${hhmm(appt.end_time)}</span></div>
    `;
    btn.disabled = false;
    btn.textContent = 'Confirmer le rendez-vous';
    setStep('done');
  }

  function resetFlow() {
    state.selectedService = null;
    state.selectedDate = null;
    state.selectedSlot = null;
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
