/* ============================================================
   Gérer mon rendez-vous — page libre-service pour la cliente/le client
   (annuler ou déplacer via le lien reçu par courriel, sans compte).
   ============================================================ */

const { createClient } = supabase;
const sb = createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

(() => {
  const el = (id) => document.getElementById(id);
  const state = { token: null, appt: null };

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  function hhmm(t) {
    return t ? String(t).slice(0, 5) : t;
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

  function showSection(name) {
    ['manage-loading', 'manage-error', 'manage-cancelled', 'manage-main', 'manage-done'].forEach((id) => {
      el(id).classList.toggle('hidden', id !== name);
    });
  }

  function recapHTML(appt) {
    return `
      ${appt.employee_name ? `<div class="row"><span>Avec</span><span>${escapeHtml(appt.employee_name)}</span></div>` : ''}
      <div class="row"><span>Service</span><span>${escapeHtml(appt.service_name)}</span></div>
      <div class="row"><span>Date</span><span>${humanDate(appt.appt_date)}</span></div>
      <div class="row"><span>Heure</span><span>${hhmm(appt.start_time)} – ${hhmm(appt.end_time)}</span></div>
    `;
  }

  async function loadAppointment() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
      el('manage-error-text').textContent = 'Lien invalide : aucun rendez-vous précisé.';
      showSection('manage-error');
      return;
    }
    state.token = token;

    const { data, error } = await sb.rpc('get_appointment_by_token', { p_token: token });
    const appt = Array.isArray(data) ? data[0] : data;

    if (error || !appt) {
      el('manage-error-text').textContent = 'Ce lien est invalide ou ce rendez-vous n\'existe plus.';
      showSection('manage-error');
      return;
    }

    state.appt = appt;
    if (appt.business_name) {
      el('biz-name').textContent = appt.business_name;
      document.title = `Gérer mon rendez-vous — ${appt.business_name}`;
    }

    if (appt.status === 'cancelled') {
      el('cancelled-recap').innerHTML = recapHTML(appt);
      showSection('manage-cancelled');
      return;
    }

    el('manage-recap').innerHTML = recapHTML(appt);
    showSection('manage-main');
  }

  el('manage-cancel-btn').addEventListener('click', async () => {
    if (!confirm('Annuler ce rendez-vous ?')) return;
    const btn = el('manage-cancel-btn');
    btn.disabled = true;
    const { error } = await sb.rpc('cancel_appointment_by_token', { p_token: state.token });
    btn.disabled = false;
    if (error) {
      const box = el('manage-error-box');
      box.textContent = "Une erreur est survenue. Réessaie, ou contacte-nous directement.";
      box.classList.remove('hidden');
      return;
    }
    el('manage-done-title').textContent = 'Rendez-vous annulé';
    el('manage-done-recap').innerHTML = recapHTML(state.appt);
    showSection('manage-done');
  });

  el('manage-move-btn').addEventListener('click', () => {
    const panel = el('manage-move-panel');
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    if (willOpen) {
      const dateInput = el('manage-date-input');
      dateInput.min = todayISO();
      if (!dateInput.value) dateInput.value = state.appt.appt_date;
      loadMoveSlots();
    }
  });

  async function loadMoveSlots() {
    const dateInput = el('manage-date-input');
    const note = el('manage-slots-note');
    const grid = el('manage-slots-grid');
    const date = dateInput.value;
    grid.innerHTML = '';
    if (!date) {
      note.textContent = 'Choisis une date pour voir les disponibilités.';
      note.classList.remove('hidden');
      return;
    }
    note.textContent = 'Chargement…';
    note.classList.remove('hidden');

    const { data: slots, error } = await sb.rpc('get_available_slots', {
      p_service_id: state.appt.service_id,
      p_employee_id: state.appt.employee_id,
      p_date: date,
      p_exclude_appointment_id: state.appt.id
    });

    if (error || !slots || !slots.length) {
      note.textContent = 'Aucune disponibilité ce jour-là. Essaie une autre date.';
      note.classList.remove('hidden');
      return;
    }
    note.classList.add('hidden');
    grid.innerHTML = slots
      .map((s) => `<button type="button" class="slot-btn" data-start="${s.start_time}">${hhmm(s.start_time)}</button>`)
      .join('');
    grid.querySelectorAll('.slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => confirmMove(date, btn.dataset.start));
    });
  }

  async function confirmMove(date, startTime) {
    if (!confirm(`Déplacer ton rendez-vous au ${humanDate(date)} à ${hhmm(startTime)} ?`)) return;
    const box = el('manage-error-box');
    box.classList.add('hidden');

    const { data, error } = await sb.rpc('reschedule_appointment_by_token', {
      p_token: state.token,
      p_date: date,
      p_start_time: startTime
    });

    if (error) {
      const msg = (error.message || '').includes('SLOT_UNAVAILABLE')
        ? "Ce créneau vient d'être pris. Choisis une autre heure."
        : "Une erreur est survenue. Réessaie, ou contacte-nous directement.";
      box.textContent = msg;
      box.classList.remove('hidden');
      loadMoveSlots();
      return;
    }

    const updated = Array.isArray(data) ? data[0] : data;
    const newAppt = { ...state.appt, appt_date: updated.appt_date, start_time: updated.start_time, end_time: updated.end_time };
    state.appt = newAppt;

    el('manage-done-title').textContent = 'Rendez-vous déplacé';
    el('manage-done-recap').innerHTML = recapHTML(newAppt);
    showSection('manage-done');
  }

  el('manage-date-input').addEventListener('change', loadMoveSlots);

  loadAppointment();
})();
