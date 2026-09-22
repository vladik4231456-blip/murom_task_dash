const API = '/api';

const state = {
  token: localStorage.getItem('duo_token') || '',
  user: JSON.parse(localStorage.getItem('duo_user') || 'null'),
  posts: [],
  viewId: null,
  formLife: 'day',
  authMode: 'login',
  lastCommentAt: 0,
  newId: null,
  refreshing: false,
  postsRequestId: 0,
  editId: null,
};

const $ = (id) => document.getElementById(id);
const body = document.body;
const board = $('board');
const searchInput = $('searchInput');
const overlay = $('overlay');
const viewOverlay = $('viewOverlay');
const authOverlay = $('authOverlay');
const adminOverlay = $('adminOverlay');
const titleInput = $('titleInput');
const textInput = $('textInput');
const errorBox = $('error');
const toast = $('toast');
const authTabs = $('authTabs');
const authNameWrap = $('authNameWrap');
const authNameInput = $('authName');
const authEmailInput = $('authEmail');
const authPasswordInput = $('authPassword');
const authErrorBox = $('authError');
const authSubmit = $('authSubmit');

const DAY = 24 * 60 * 60 * 1000;
let toastTimer = null;
let undoAction = null;

const savedTheme = localStorage.getItem('duo_theme');
if (savedTheme === 'dark') {
  body.classList.add('dark-theme');
  $('themeBtn').textContent = '☀️';
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('duo_token', token || '');
  localStorage.setItem('duo_user', JSON.stringify(user || null));
  updateAuthUi();
}

function clearSession() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('duo_token');
  localStorage.removeItem('duo_user');
  updateAuthUi();
}

function updateAuthUi() {
  const authBtn = $('authBtn');
  const userPill = $('userPill');

  if (authBtn) {
    authBtn.textContent = state.user ? 'Выйти' : 'Войти';
  }

  $('adminBtn').classList.toggle('hidden', !state.user || state.user.role !== 'admin');

  if (userPill) {
    if (state.user) {
      userPill.textContent = state.user.name;
      userPill.classList.remove('hidden');
    } else {
      userPill.textContent = '';
      userPill.classList.add('hidden');
    }
  }

}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload.message || 'Ошибка запроса';
    throw new Error(message);
  }

  return payload;
}

function showToast(text, undo) {
  undoAction = undo || null;
  $('toastText').textContent = text;
  $('toastUndo').style.display = undo ? '' : 'none';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    undoAction = null;
  }, 4500);
}

$('toastUndo').addEventListener('click', () => {
  if (undoAction) undoAction();
  undoAction = null;
  toast.classList.remove('show');
});

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayLabel(ts) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / DAY);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function stamp(ts) {
  const sameDay = startOfDay(new Date(ts)).getTime() === startOfDay(new Date()).getTime();
  return sameDay
    ? timeLabel(ts)
    : `${new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${timeLabel(ts)}`;
}

function leftLabel(expiresAt) {
  const ms = Math.max(0, expiresAt - Date.now());
  const days = Math.floor(ms / DAY);
  if (days >= 1) return `${days} дн.`;
  const hrs = Math.floor(ms / 3600e3);
  if (hrs >= 1) return `${hrs} ч.`;
  return `${Math.max(1, Math.ceil(ms / 60e3))} мин.`;
}

async function loadPosts({ silent = false } = {}) {
  const requestId = ++state.postsRequestId;
  try {
    const q = searchInput.value.trim();
    const query = q ? `?q=${encodeURIComponent(q)}` : '';
    const data = await api(`/posts${query}`);
    if (requestId !== state.postsRequestId) return;
    state.posts = data.posts || [];
    render();
  } catch (error) {
    console.error(error);
    if (!silent) showToast(error.message || 'Не удалось загрузить ленту');
  }
}

function createCard(post) {
  const card = document.createElement('article');
  card.className = `card${post.id === state.newId ? ' new' : ''}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Открыть объявление: ${post.title}`);

  const handleOpen = () => openView(post.id);
  card.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn')) return;
    handleOpen();
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      handleOpen();
    }
  });

  const head = document.createElement('div');
  head.className = 'card-head';

  const h = document.createElement('h3');
  h.className = 'card-title';
  h.textContent = post.title;
  head.appendChild(h);

  if (state.user && post.own) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn';
    edit.setAttribute('aria-label', 'Редактировать объявление');
    edit.textContent = '✎';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openEdit(post);
    });
    head.appendChild(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn del';
    del.setAttribute('aria-label', 'Удалить объявление');
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      removePost(post.id);
    });

    head.append(edit, del);
  }

  card.appendChild(head);

  if (post.text) {
    const hr = document.createElement('hr');
    hr.className = 'card-line';
    const text = document.createElement('p');
    text.className = 'card-text';
    text.textContent = post.text;
    card.append(hr, text);
  }

  const foot = document.createElement('div');
  foot.className = 'card-foot';

  const time = document.createElement('time');
  time.textContent = timeLabel(post.created_at);

  const stats = document.createElement('span');
  stats.className = 'stats';

  const likes = document.createElement('span');
  likes.className = post.liked ? 'liked' : '';
  likes.textContent = `${post.liked ? '♥' : '♡'} ${post.likes}`;

  const comments = document.createElement('span');
  comments.textContent = `💬 ${post.comments.length}`;

  stats.append(likes, comments);
  foot.append(time, stats);
  card.appendChild(foot);

  return card;
}

function addGroup(label, items) {
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.textContent = label;

  const feed = document.createElement('div');
  feed.className = 'feed';
  items.forEach((post) => feed.appendChild(createCard(post)));

  board.append(div, feed);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const list = state.posts.filter((post) => {
    if (!query) return true;
    return `${post.title} ${post.text}`.toLowerCase().includes(query);
  });

  board.textContent = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.posts.length
      ? 'Ничего не найдено. Попробуйте другой запрос.'
      : 'Пока пусто. Нажмите «+», чтобы добавить объявление.';
    board.appendChild(empty);
    state.newId = null;
    return;
  }

  const rest = list.sort((a, b) => b.created_at - a.created_at);
  let lastLabel = null;
  let group = [];

  rest.forEach((post) => {
    const label = dayLabel(post.created_at);
    if (label !== lastLabel) {
      if (group.length) addGroup(lastLabel, group);
      group = [];
      lastLabel = label;
    }
    group.push(post);
  });

  if (group.length) addGroup(lastLabel, group);
  state.newId = null;
}

searchInput.addEventListener('input', loadPosts);

$('themeBtn').addEventListener('click', () => {
  const isDark = body.classList.toggle('dark-theme');
  $('themeBtn').textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('duo_theme', isDark ? 'dark' : 'light');
});

function openOverlay(element) {
  element.classList.add('open');
  element.setAttribute('aria-hidden', 'false');
  body.style.overflow = 'hidden';
}

function closeOverlay(element) {
  element.classList.remove('open');
  element.setAttribute('aria-hidden', 'true');

  const anyOpen = [overlay, viewOverlay, authOverlay, adminOverlay, $('editOverlay')].some((item) => item.classList.contains('open'));
  if (!anyOpen) body.style.overflow = '';
}

function openModal() {
  if (!state.user) {
    openAuth('login');
    return;
  }

  openOverlay(overlay);
  setTimeout(() => titleInput.focus(), 200);
}

function closeModal() {
  errorBox.textContent = '';
  closeOverlay(overlay);
}

$('fab').addEventListener('click', openModal);
$('closeBtn').addEventListener('click', closeModal);
$('cancelBtn').addEventListener('click', closeModal);
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeModal();
});

function openAuth(mode = 'login') {
  state.authMode = mode;
  authNameWrap.classList.toggle('hidden', mode !== 'register');
  authSubmit.textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
  authTabs.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.auth === mode);
  });
  authErrorBox.textContent = '';
  authNameInput.value = '';
  authEmailInput.value = '';
  authPasswordInput.value = '';
  authEmailInput.setAttribute('autocomplete', 'username');
  authPasswordInput.setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  openOverlay(authOverlay);
  setTimeout(() => (mode === 'register' ? authNameInput.focus() : authEmailInput.focus()), 200);
}

function closeAuth() {
  closeOverlay(authOverlay);
}

$('authClose').addEventListener('click', closeAuth);
authOverlay.addEventListener('click', (event) => {
  const activeField = document.activeElement;
  const editingAuthField = activeField && (
    activeField === authNameInput ||
    activeField === authEmailInput ||
    activeField === authPasswordInput
  );
  if (event.target === authOverlay && !editingAuthField) closeAuth();
});

authTabs.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  openAuth(chip.dataset.auth);
});

async function submitAuth() {
  const name = authNameInput.value.trim();
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value.trim();

  if (!email || !password) {
    authErrorBox.textContent = 'Введите email и пароль';
    return;
  }

  if (state.authMode === 'register' && !name) {
    authErrorBox.textContent = 'Введите имя';
    return;
  }

  try {
    const endpoint = state.authMode === 'register' ? '/auth/register' : '/auth/login';
    const body = state.authMode === 'register' ? { name, email, password } : { email, password };
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    saveSession(result.token, result.user);
    closeAuth();
    showToast(state.authMode === 'register' ? 'Аккаунт создан' : 'Вы вошли');
    await loadPosts();
  } catch (error) {
    authErrorBox.textContent = error.message || 'Не удалось выполнить действие';
  }
}

authSubmit.addEventListener('click', submitAuth);

$('authBtn').addEventListener('click', () => {
  if (state.user) {
    clearSession();
    showToast('Вы вышли');
    loadPosts();
    return;
  }
  openAuth('login');
});

function openAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  openOverlay(adminOverlay);
  loadReports();
}

function closeAdmin() {
  closeOverlay(adminOverlay);
}


async function loadReports() {
  const reports = $('adminReports');
  const reportError = $('adminReportsError');
  reports.textContent = '';
  reportError.textContent = '';
  try {
    const result = await api('/mod/reports');
    if (!result.reports.length) {
      reports.innerHTML = '<p class="no-comments">Новых жалоб нет.</p>';
      return;
    }
    result.reports.forEach((report) => {
      const row = document.createElement('div');
      row.className = 'admin-report';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = report.post_title;
      const details = document.createElement('p');
      details.textContent = `${report.post_text} · пожаловался ${report.reporter_name}`;
      info.append(title, details);

      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn primary';
      remove.textContent = 'Удалить объявление';
      remove.addEventListener('click', async () => {
        await api(`/mod/posts/${report.post_id}`, { method: 'DELETE' });
        await loadReports();
        await loadPosts({ silent: true });
        showToast('Объявление удалено модератором');
      });
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'btn';
      dismiss.textContent = 'Игнорировать';
      dismiss.addEventListener('click', async () => {
        await api(`/mod/reports/${report.id}`, { method: 'DELETE' });
        loadReports();
      });
      actions.append(remove, dismiss);
      row.append(info, actions);
      reports.appendChild(row);
    });
  } catch (error) {
    reportError.textContent = error.message || 'Не удалось загрузить жалобы';
  }
}

function openEdit(post) {
  state.editId = post.id;
  $('editPostTitle').value = post.title;
  $('editPostText').value = post.text;
  $('editError').textContent = '';
  openOverlay($('editOverlay'));
  setTimeout(() => $('editPostTitle').focus(), 150);
}

function closeEdit() {
  state.editId = null;
  closeOverlay($('editOverlay'));
}

async function saveEdit() {
  try {
    const result = await api(`/posts/${state.editId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: $('editPostTitle').value, text: $('editPostText').value }),
    });
    state.posts = state.posts.map((post) => post.id === result.post.id ? result.post : post);
    closeEdit();
    render();
    if (state.viewId === result.post.id) renderView();
    showToast('Объявление обновлено');
  } catch (error) {
    $('editError').textContent = error.message || 'Не удалось сохранить изменения';
  }
}

$('adminReportsBtn').addEventListener('click', loadReports);
$('editClose').addEventListener('click', closeEdit);
$('editSave').addEventListener('click', saveEdit);
$('editOverlay').addEventListener('click', (event) => {
  if (event.target === $('editOverlay')) closeEdit();
});

$('adminBtn').addEventListener('click', openAdmin);
$('adminClose').addEventListener('click', closeAdmin);
adminOverlay.addEventListener('click', (event) => {
  if (event.target === adminOverlay) closeAdmin();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (authOverlay.classList.contains('open')) closeAuth();
  else if (adminOverlay.classList.contains('open')) closeAdmin();
  else if ($('editOverlay').classList.contains('open')) closeEdit();
  else if (viewOverlay.classList.contains('open')) closeView();
  else if (overlay.classList.contains('open')) closeModal();
});

function openView(id) {
  state.viewId = id;
  $('commentInput').value = '';
  $('commentError').textContent = '';
  renderView();
  openOverlay(viewOverlay);
  viewOverlay.querySelector('.modal').scrollTop = 0;
}

function closeView() {
  state.viewId = null;
  closeOverlay(viewOverlay);
}

function renderView() {
  const post = state.posts.find((item) => item.id === state.viewId);
  if (!post) {
    closeView();
    return;
  }

  $('viewMeta').textContent = `${dayLabel(post.created_at)}, ${timeLabel(post.created_at)} · осталось ${leftLabel(post.expires_at)}`;
  $('viewTitle').textContent = post.title;
  $('viewText').textContent = post.text;
  $('viewText').style.display = post.text ? '' : 'none';
  $('likeIcon').textContent = post.liked ? '♥' : '♡';
  $('likeBtn').classList.toggle('on', post.liked);
  $('likeCount').textContent = post.likes;
  $('commentCount').textContent = post.comments.length;

  const list = $('commentList');
  list.textContent = '';
  if (!post.comments.length) {
    const none = document.createElement('div');
    none.className = 'no-comments';
    none.textContent = 'Комментариев пока нет. Будьте первым.';
    list.appendChild(none);
  }

  post.comments.forEach((comment) => {
    const row = document.createElement('div');
    row.className = 'comment';

    const top = document.createElement('div');
    top.className = 'comment-top';

    const name = document.createElement('strong');
    name.textContent = comment.author;

    const when = document.createElement('span');
    when.textContent = stamp(comment.created_at);
    top.append(name, when);

    if (state.user && (comment.own || state.user.role === 'admin')) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn del';
      del.setAttribute('aria-label', 'Удалить комментарий');
      del.textContent = '×';
      del.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          const endpoint = state.user.role === 'admin' && !comment.own
            ? `/mod/posts/${post.id}/comments/${comment.id}`
            : `/posts/${post.id}/comments/${comment.id}`;
          await api(endpoint, { method: 'DELETE' });
          await loadPosts();
          if (state.viewId === post.id) renderView();
        } catch (error) {
          showToast(error.message || 'Не удалось удалить комментарий');
        }
      });
      top.appendChild(del);
    }

    const text = document.createElement('p');
    text.textContent = comment.text;
    row.append(top, text);
    list.appendChild(row);
  });

  const reportBtn = $('reportBtn');
  reportBtn.disabled = !!post.reported || !state.user;
  reportBtn.textContent = post.reported ? '🚩 Жалоба отмечена' : '🚩 Пожаловаться';
}

$('viewClose').addEventListener('click', closeView);
viewOverlay.addEventListener('click', (event) => {
  if (event.target === viewOverlay) closeView();
});

$('likeBtn').addEventListener('click', async () => {
  if (!state.user) {
    openAuth('login');
    return;
  }

  try {
    const result = await api(`/posts/${state.viewId}/like`, { method: 'POST' });
    const updated = result.post;
    state.posts = state.posts.map((post) => (post.id === updated.id ? updated : post));
    render();
    renderView();
  } catch (error) {
    showToast(error.message || 'Не удалось поставить лайк');
  }
});

$('commentJump').addEventListener('click', () => {
  $('commentsTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('commentInput').focus({ preventScroll: true });
});

async function sendComment() {
  if (!state.user) {
    openAuth('login');
    return;
  }

  const post = state.posts.find((item) => item.id === state.viewId);
  if (!post) return;

  const input = $('commentInput');
  const text = input.value.trim();
  const error = $('commentError');

  if (!text) {
    error.textContent = 'Напишите текст комментария.';
    return;
  }

  if (Date.now() - state.lastCommentAt < 3000) {
    error.textContent = 'Не так быстро, подождите пару секунд.';
    return;
  }

  try {
    const result = await api(`/posts/${post.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    state.lastCommentAt = Date.now();
    error.textContent = '';
    input.value = '';
    state.posts = state.posts.map((item) => (item.id === result.post.id ? result.post : item));
    render();
    renderView();
  } catch (error) {
    error.textContent = error.message || 'Не удалось отправить комментарий';
  }
}

$('commentSend').addEventListener('click', sendComment);
$('commentInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendComment();
  }
});

$('reportBtn').addEventListener('click', async () => {
  if (!state.user) {
    openAuth('login');
    return;
  }

  const post = state.posts.find((item) => item.id === state.viewId);
  if (!post || post.reported) return;

  try {
    await api(`/posts/${post.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'spam' }),
    });
    await loadPosts();
    renderView();
    showToast('Жалоба отправлена модераторам.');
  } catch (error) {
    showToast(error.message || 'Не удалось отправить жалобу');
  }
});

function resetForm() {
  titleInput.value = '';
  textInput.value = '';
  $('titleCount').textContent = '0/60';
  $('textCount').textContent = '0/300';
}

$('publishBtn').addEventListener('click', async () => {
  if (!state.user) {
    openAuth('login');
    return;
  }

  const title = titleInput.value.trim();
  const text = textInput.value.trim();

  if (!title) {
    errorBox.textContent = 'Добавьте заголовок объявления.';
    titleInput.focus();
    return;
  }

  if (!text) {
    errorBox.textContent = 'Добавьте текст объявления.';
    textInput.focus();
    return;
  }

  try {
    const result = await api('/posts', {
      method: 'POST',
      body: JSON.stringify({ title, text }),
    });

    state.newId = result.post.id;
    resetForm();
    closeModal();
    searchInput.value = '';
    await loadPosts();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    errorBox.textContent = error.message || 'Не удалось опубликовать объявление';
  }
});

async function removePost(id) {
  const post = state.posts.find((item) => item.id === id);
  if (!post) return;

  try {
    if (state.viewId === id) closeView();
    await api(`/posts/${id}`, { method: 'DELETE' });
    state.posts = state.posts.filter((item) => item.id !== id);
    render();
    showToast('Объявление удалено', () => {
      state.posts = [post, ...state.posts];
      render();
    });
  } catch (error) {
    showToast(error.message || 'Не удалось удалить объявление');
  }
}

$('titleInput').addEventListener('input', () => {
  $('titleCount').textContent = `${$('titleInput').value.length}/60`;
});
$('textInput').addEventListener('input', () => {
  $('textCount').textContent = `${$('textInput').value.length}/300`;
});

async function init() {
  updateAuthUi();

  if (state.token) {
    try {
      const result = await api('/auth/me');
      saveSession(state.token, result.user);
    } catch (error) {
      clearSession();
      console.warn('Session invalid:', error.message);
    }
  }

  resetForm();
  await loadPosts();
  startLiveRefresh();
}

function startLiveRefresh() {
  setInterval(async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      await loadPosts({ silent: true });
      if (state.viewId && viewOverlay.classList.contains('open')) renderView();
    } finally {
      state.refreshing = false;
    }
  }, 10000);
}

init();