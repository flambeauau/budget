'use strict';

const PAYDAY = 25; // зарплата 25-го; якщо це вихідний — у п'ятницю перед ним
const FIELDS = ['name', 'weight', 'price', 'kcal', 'protein', 'fat', 'carbs'];
const COLORS = ['yellow', 'pink', 'olive', 'blue'];
const $ = (s) => document.querySelector(s);

// ---------- Сховище (Supabase: таблиця items + бакет photos) ----------

if (!window.CONFIG || !window.CONFIG.SUPABASE_URL) {
  document.body.innerHTML = '<p style="padding:24px">Supabase ще не налаштовано — заповни config.js</p>';
  throw new Error('config.js is empty');
}
const sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_KEY);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
let user = null;

const fromRow = (r) => ({
  id: r.id,
  name: r.name,
  date: r.date,
  photo: r.photo,
  weight: numOrNull(r.weight),
  price: Number(r.price) || 0,
  kcal: numOrNull(r.kcal),
  protein: numOrNull(r.protein),
  fat: numOrNull(r.fat),
  carbs: numOrNull(r.carbs),
  createdAt: Date.parse(r.created_at),
});

const toRow = (it) => {
  const row = { name: it.name, date: it.date, photo: it.photo || null, price: it.price || 0 };
  for (const k of ['weight', 'kcal', 'protein', 'fat', 'carbs']) row[k] = it[k] ?? null;
  if (it.id && UUID_RE.test(it.id)) row.id = it.id;
  return row;
};

async function getAll() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('items').select('*').order('created_at').range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all.map(fromRow);
}

async function putItem(item) {
  const { data, error } = await sb.from('items').upsert(toRow(item)).select().single();
  if (error) throw error;
  return fromRow(data);
}

async function delItem(id) {
  const { error } = await sb.from('items').delete().eq('id', id);
  if (error) throw error;
}

async function putMany(list) {
  const { error } = await sb.from('items').upsert(list.map(toRow));
  if (error) throw error;
}

// Фото з форми — це data:URL; заливаємо в Storage і зберігаємо посилання
async function uploadPhoto(data) {
  if (!data || !data.startsWith('data:')) return data || null;
  const blob = await (await fetch(data)).blob();
  const path = `${user.id}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return sb.storage.from('photos').getPublicUrl(path).data.publicUrl;
}

// ---------- Дати та періоди ----------

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => iso(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const monthIndex = (d) => d.getFullYear() * 12 + d.getMonth();

// День зарплати в місяці mi (рік*12 + місяць): 25-те, або п'ятниця, якщо 25-те — субота/неділя
function payday(mi) {
  const d = new Date(Math.floor(mi / 12), mi % 12, PAYDAY);
  const wd = d.getDay();
  if (wd === 6) return addDays(d, -1);
  if (wd === 0) return addDays(d, -2);
  return d;
}

function periodOf(dateStr) {
  const d = parseISO(dateStr);
  const mi = monthIndex(d);
  return d >= payday(mi) ? mi : mi - 1;
}

function periodRange(mi) {
  const start = payday(mi);
  const next = payday(mi + 1);
  const end = addDays(next, -1);
  return { start, end, next, from: iso(start), to: iso(end) };
}

// ---------- Форматування ----------

const nf = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const money = (x) => `${nf.format(x)} CHF`;
const money0 = (x) => `${nf0.format(x)} CHF`;
const shortDate = (d) => d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
const dayMonth = (d) => d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
const longDate = (s) => parseISO(s).toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function colorFor(name) {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ---------- Стан ----------

let items = [];
let period = periodOf(todayISO());
let selectedDay = null;
let query = '';
let editing = null;
let photoData = null;

// ---------- Відмальовка ----------

function render() {
  const r = periodRange(period);
  const today = todayISO();
  const isCurrent = r.from <= today && today <= r.to;
  if (selectedDay && (selectedDay < r.from || selectedDay > r.to)) selectedDay = null;

  $('#periodLabel').textContent = `${shortDate(r.start)} – ${shortDate(r.end)}`;
  $('#periodHint').textContent = `${r.end.getFullYear()}${isCurrent ? ' · зараз' : ''}`;
  $('#next').disabled = r.to >= today;

  const inPeriod = items.filter((i) => i.date >= r.from && i.date <= r.to);

  const days = [];
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) days.push(iso(d));

  const daily = new Map();
  let spent = 0;
  for (const it of inPeriod) {
    const day = daily.get(it.date) || { spent: 0 };
    day.spent += it.price || 0;
    daily.set(it.date, day);
    spent += it.price || 0;
  }
  const elapsed = isCurrent ? daysBetween(r.start, parseISO(today)) + 1 : days.length;

  renderHello(r, isCurrent, spent);
  renderCards(spent, inPeriod.length, elapsed, days, daily, today);
  renderCalendar(r, daily, today);
  renderTop(inPeriod);
  renderList(inPeriod);
  renderNames();
}

function renderHello(r, isCurrent, spent) {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 5 ? 'Доброї ночі 🌙' : h < 12 ? 'Доброго ранку ☀️' : h < 18 ? 'Доброго дня 🌿' : 'Доброго вечора 🌙';
  if (isCurrent) {
    const n = daysBetween(parseISO(todayISO()), r.next);
    $('#subtitle').textContent =
      `Зарплата через ${n} ${plural(n, 'день', 'дні', 'днів')} — ${dayMonth(r.next)}. ` +
      `Цього місяця на їжу пішло ${money(spent)}.`;
  } else {
    $('#subtitle').textContent = `Місяць ${dayMonth(r.start)} – ${dayMonth(r.end)}: на їжу пішло ${money(spent)}.`;
  }
}

function renderCards(spent, count, elapsed, days, daily, today) {
  $('#sumSpent').textContent = money(spent);

  const max = Math.max(1, ...days.map((d) => daily.get(d)?.spent || 0));
  $('#dailyBars').innerHTML = days.map((d) => {
    const v = daily.get(d)?.spent || 0;
    const cls = d > today ? 'future' : v ? '' : 'zero';
    return `<i class="${cls}" style="height:${Math.max((v / max) * 100, 4)}%" title="${shortDate(parseISO(d))}: ${money(v)}"></i>`;
  }).join('');

  $('#sumAvg').innerHTML =
    `<div><b>${money(spent / elapsed)}</b><small>на день</small></div>` +
    `<div><b>${count}</b><small>${plural(count, 'покупка', 'покупки', 'покупок')}</small></div>`;
}

function renderCalendar(r, daily, today) {
  const gridStart = addDays(r.start, -((r.start.getDay() + 6) % 7));
  const gridEnd = addDays(r.end, 6 - ((r.end.getDay() + 6) % 7));
  const nextPay = iso(r.next);

  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((w) => `<span class="wd">${w}</span>`).join('');
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    const s = iso(d);
    const inside = s >= r.from && s <= r.to;
    const cls = ['d'];
    if (!inside) cls.push('out');
    if (s === r.from || s === nextPay) cls.push('pay');
    else if (daily.has(s)) cls.push('has');
    if (s === today) cls.push('today');
    if (s === selectedDay) cls.push('sel');
    const spent = daily.get(s)?.spent;
    const title = `${shortDate(d)}${s === r.from || s === nextPay ? ' · зарплата' : ''}${spent ? ` · ${money(spent)}` : ''}`;
    html += inside
      ? `<button class="${cls.join(' ')}" data-day="${s}" title="${title}">${d.getDate()}</button>`
      : `<span class="${cls.join(' ')}" title="${title}">${d.getDate()}</span>`;
  }
  $('#calendar').innerHTML = html;
}

function renderTop(list) {
  const byName = new Map();
  for (const it of list) {
    const key = it.name.trim().toLowerCase();
    const g = byName.get(key) || { name: it.name, sum: 0, n: 0 };
    g.sum += it.price || 0;
    g.n += 1;
    byName.set(key, g);
  }
  const box = $('#top');
  if (byName.size < 2) { box.innerHTML = ''; return; }

  const top = [...byName.values()].sort((a, b) => b.sum - a.sum).slice(0, 5);
  const max = top[0].sum || 1;
  box.className = 'top';
  box.innerHTML = '<h3>На що найбільше пішло</h3>' + top.map((g) => `
    <div class="bar-row">
      <span class="name">${esc(g.name)}${g.n > 1 ? ` <small>×${g.n}</small>` : ''}</span>
      <span class="sum">${money0(g.sum)}</span>
      <span class="bar"><i class="c-${colorFor(g.name)}" style="width:${(g.sum / max) * 100}%"></i></span>
    </div>`).join('');
}

function renderList(inPeriod) {
  const chip = $('#dayChip');
  chip.hidden = !selectedDay;
  if (selectedDay) chip.textContent = `${shortDate(parseISO(selectedDay))} ✕`;

  const list = inPeriod
    .filter((i) => !selectedDay || i.date === selectedDay)
    .filter((i) => !query || i.name.toLowerCase().includes(query))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const box = $('#list');
  if (!list.length) {
    const msg = query ? 'Нічого не знайшлося 🤷‍♀️'
      : selectedDay ? 'Цього дня покупок не було'
      : 'У цьому місяці ще немає покупок.<br>Тисни «+ Додати покупку» 🛒';
    box.innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }

  const groups = new Map();
  for (const it of list) {
    if (!groups.has(it.date)) groups.set(it.date, []);
    groups.get(it.date).push(it);
  }

  box.innerHTML = [...groups].map(([date, group]) => {
    const daySum = group.reduce((s, i) => s + (i.price || 0), 0);
    return `
      <div class="day">
        <div class="day-head"><span>${longDate(date)}</span><span>${money(daySum)}</span></div>
        ${group.map(itemHTML).join('')}
      </div>`;
  }).join('');
}

function itemHTML(it) {
  const color = colorFor(it.name);
  const meta = [];
  if (it.weight) meta.push(`${nf.format(it.weight)} г`);
  if (it.weight && it.price) meta.push(`${money((it.price / it.weight) * 1000)}/кг`);
  const kbju = [
    it.kcal != null && `${nf0.format(it.kcal)} ккал`,
    it.protein != null && `Б ${nf.format(it.protein)}`,
    it.fat != null && `Ж ${nf.format(it.fat)}`,
    it.carbs != null && `В ${nf.format(it.carbs)}`,
  ].filter(Boolean);
  const thumb = it.photo
    ? `<img class="thumb" src="${it.photo}" alt="">`
    : `<span class="thumb c-${color}">🛒</span>`;
  return `
    <button class="item" data-id="${esc(it.id)}">
      ${thumb}
      <span class="info">
        <div class="name">${esc(it.name)}</div>
        <div class="meta">${meta.join(' · ') || '&nbsp;'}</div>
        ${kbju.length ? `<div class="kbju">${kbju.join(' · ')} на 100 г</div>` : ''}
      </span>
      <span class="pill c-${color}">${money(it.price || 0)}</span>
    </button>`;
}

function latestByName() {
  const map = new Map();
  for (const it of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    map.set(it.name.trim().toLowerCase(), it);
  }
  return map;
}

function renderNames() {
  $('#names').innerHTML = [...latestByName().values()]
    .map((i) => `<option value="${esc(i.name)}">`).join('');
}

// ---------- Форма ----------

const form = $('#form');
const dlg = $('#dlg');

function setPhoto(data) {
  photoData = data || null;
  $('#photoPreview').hidden = !photoData;
  $('#photoHint').hidden = !!photoData;
  $('#photoClear').hidden = !photoData;
  if (photoData) $('#photoPreview').src = photoData;
  else $('#photoPreview').removeAttribute('src');
}

function defaultDate() {
  if (selectedDay) return selectedDay;
  const { from, to } = periodRange(period);
  const today = todayISO();
  return today >= from && today <= to ? today : to;
}

function openForm(item) {
  editing = item || null;
  form.reset();
  $('#formTitle').textContent = item ? 'Редагувати покупку' : 'Нова покупка';
  $('#deleteBtn').hidden = !item;
  for (const k of FIELDS) form.elements[k].value = item ? (item[k] ?? '') : '';
  form.elements.date.value = item ? item.date : defaultDate();
  setPhoto(item ? item.photo : null);
  dlg.showModal();
}

// Ресайз фото, щоб не забивати пам'ять браузера
function resizeImage(file, max = 640) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати фото')); };
    img.src = url;
  });
}

$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { setPhoto(await resizeImage(file)); }
  catch (err) { alert(err.message); }
});

$('#photoClear').addEventListener('click', () => setPhoto(null));

// Якщо вибрала продукт, який вже купувала — підставляємо його дані
form.elements.name.addEventListener('change', () => {
  if (editing) return;
  const prev = latestByName().get(form.elements.name.value.trim().toLowerCase());
  if (!prev) return;
  for (const k of FIELDS) {
    if (k !== 'name' && form.elements[k].value === '' && prev[k] != null) form.elements[k].value = prev[k];
  }
  if (!photoData && prev.photo) setPhoto(prev.photo);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = (k) => {
    const v = parseFloat(String(form.elements[k].value).replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };
  const saveBtn = form.querySelector('[type=submit]');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Зберігаю…';
  try {
    const saved = await putItem({
      id: editing ? editing.id : undefined,
      name: form.elements.name.value.trim(),
      date: form.elements.date.value,
      photo: await uploadPhoto(photoData),
      weight: num('weight'),
      price: num('price') || 0,
      kcal: num('kcal'),
      protein: num('protein'),
      fat: num('fat'),
      carbs: num('carbs'),
    });
    items = items.filter((i) => i.id !== saved.id).concat(saved);
    period = periodOf(saved.date);
    dlg.close();
    render();
  } catch (err) {
    alert(`Не вдалося зберегти: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Зберегти';
  }
});

$('#deleteBtn').addEventListener('click', async () => {
  if (!editing || !confirm(`Видалити «${editing.name}»?`)) return;
  try {
    await delItem(editing.id);
    items = items.filter((i) => i.id !== editing.id);
    dlg.close();
    render();
  } catch (err) {
    alert(`Не вдалося видалити: ${err.message}`);
  }
});

$('#cancelBtn').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ---------- Навігація ----------

$('#addBtn').addEventListener('click', () => openForm());
$('#fab').addEventListener('click', () => openForm());

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (btn) openForm(items.find((i) => i.id === btn.dataset.id));
});

$('#calendar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-day]');
  if (!btn) return;
  selectedDay = selectedDay === btn.dataset.day ? null : btn.dataset.day;
  render();
});

$('#dayChip').addEventListener('click', () => { selectedDay = null; render(); });

$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  render();
});

$('#prev').addEventListener('click', () => { period -= 1; selectedDay = null; render(); });
$('#next').addEventListener('click', () => { period += 1; selectedDay = null; render(); });

// ---------- Резервна копія ----------

$('#exportBtn').addEventListener('click', () => {
  const data = JSON.stringify({ version: 1, exported: new Date().toISOString(), items });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `food-budget-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = (Array.isArray(data) ? data : data.items || [])
      .filter((i) => i && i.name && /^\d{4}-\d{2}-\d{2}$/.test(i.date));
    if (!list.length) throw new Error('У файлі немає покупок');
    for (const it of list) it.photo = await uploadPhoto(it.photo);
    await putMany(list);
    items = await getAll();
    render();
    alert(`Відновлено покупок: ${list.length}`);
  } catch (err) {
    alert(`Не вдалося відновити: ${err.message}`);
  }
});

// ---------- Вхід і старт ----------

async function loadItems() {
  try {
    items = await getAll();
    render();
  } catch (err) {
    alert(`Не вдалося завантажити покупки: ${err.message}`);
  }
}

function showApp(signedIn) {
  document.body.classList.toggle('locked', !signedIn);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  $('#loginError').textContent = '';
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: f.elements.email.value.trim(),
    password: f.elements.password.value,
  });
  btn.disabled = false;
  if (error) $('#loginError').textContent = 'Неправильна пошта або пароль';
});

$('#logoutBtn').addEventListener('click', () => sb.auth.signOut());

sb.auth.onAuthStateChange((event, session) => {
  const wasIn = !!user;
  user = session ? session.user : null;
  showApp(!!user);
  if (user && !wasIn) setTimeout(loadItems, 0); // не можна чекати запити всередині цього колбека
  if (!user) { items = []; render(); }
});

// Повернулась у вкладку (напр. внесла щось з телефона) — підтягуємо свіже
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && user && !dlg.open) loadItems();
});

render();
