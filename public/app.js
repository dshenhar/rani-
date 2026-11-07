'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function svg(paths) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '1.8');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      el.append(p);
    }
    return el;
  }
  const icons = {
    lock: () => svg(['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v10H5z']),
    video: () => svg(['M3 6h12v12H3z', 'M15 10l6-3v10l-6-3']),
    audio: () => svg(['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3']),
    image: () => svg(['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6']),
    edit: () => svg(['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4']),
  };

  const dateFormat = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDate = (iso) => dateFormat.format(new Date(iso));
  function fmtSize(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  // Who may edit is decided by the server (a cookie set when posting). The key is
  // also kept here only to offer a link for editing from another device.
  const editKeys = {
    get: (postId) => store.get(`memorial:edit:${postId}`),
    set: (postId, key) => store.set(`memorial:edit:${postId}`, key),
    remove: (postId) => store.remove(`memorial:edit:${postId}`),
  };

  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(data.error || 'אירעה שגיאה. נסו שוב.');
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- state ----------

  const state = {
    role: 'guest',
    loginEnabled: false,
    maxFileMB: 1024,
    uploadMode: 'local',
    uploadTypes: [],
    settings: { name: '', subtitle: '', coverUrl: null },
    posts: [],
    filter: 'all',
    drive: null, // admin only: { connected, email } when files go to Google Drive
    driveFlash: null,
  };

  const DRIVE_MESSAGES = {
    connected: 'גוגל דרייב חובר.',
    folder: 'לחשבון שנבחר אין הרשאה להוסיף קבצים לתיקייה שהוגדרה. בחרו חשבון שחבר בדרייב המשותף, או בדקו את GOOGLE_DRIVE_FOLDER_ID.',
    admin: 'צריך להיכנס עם קוד המנהל לפני החיבור.',
    cancelled: 'החיבור בוטל.',
    error: 'החיבור לגוגל לא הצליח. נסו שוב.',
  };

  async function load() {
    const data = await api('/api/state', { cache: 'no-store' });
    Object.assign(state, data);
    render();
  }

  function render() {
    renderHero();
    renderFilters();
    renderFeed();
    renderFooter();
  }

  const canEdit = (post) => Boolean(post.canEdit);

  // ---------- header ----------

  function renderHero() {
    const { name, subtitle, coverUrl } = state.settings;
    document.title = name;
    $('#name').textContent = name;
    const sub = $('#subtitle');
    sub.textContent = subtitle || '';
    sub.hidden = !subtitle;
    const img = $('#portrait');
    if (coverUrl) {
      if (img.getAttribute('src') !== coverUrl) img.src = coverUrl;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    $('#admin-bar').hidden = state.role !== 'admin';
    renderDriveBox();
  }

  // Admin only: whether a Google account is connected for storing the files.
  function renderDriveBox() {
    const box = $('#drive-box');
    const drive = state.role === 'admin' ? state.drive : null;
    if (!drive) { box.hidden = true; return; }
    box.hidden = false;
    const flash = state.driveFlash ? h('p', { class: 'drive-flash' }, DRIVE_MESSAGES[state.driveFlash] || DRIVE_MESSAGES.error) : null;
    if (drive.connected) {
      box.className = 'drive-box';
      box.replaceChildren(flash || '',
        h('span', null, `גוגל דרייב: ${drive.email || 'מחובר'}`),
        h('span', { 'aria-hidden': 'true' }, ' · '),
        h('a', { id: 'drive-connect', class: 'link', href: '/api/google/connect' }, 'החלפת חשבון'));
    } else {
      box.className = 'drive-box warn';
      box.replaceChildren(flash || '',
        h('p', null, 'גוגל דרייב עוד לא מחובר, ולכן אי אפשר להעלות.'),
        h('a', { id: 'drive-connect', class: 'btn primary', href: '/api/google/connect' }, 'חיבור לגוגל דרייב'));
    }
  }

  function renderFooter() {
    const member = state.role === 'family' || state.role === 'admin';
    $('#member-links').hidden = !member;
    $('#guest-links').hidden = member || !state.loginEnabled;
  }

  // ---------- feed ----------

  const FILTERS = [
    ['all', 'הכל'], ['text', 'סיפורים'], ['image', 'תמונות'], ['video', 'סרטונים'], ['audio', 'הקלטות'],
  ];

  function categories(post) {
    const set = new Set();
    if (post.text) set.add('text');
    for (const f of post.files) set.add(f.type);
    return set;
  }

  function renderFilters() {
    const nav = $('#filters');
    const counts = {};
    for (const post of state.posts) for (const c of categories(post)) counts[c] = (counts[c] || 0) + 1;
    const available = FILTERS.filter(([key]) => key === 'all' || counts[key]);
    if (!available.some(([key]) => key === state.filter)) state.filter = 'all';
    nav.replaceChildren();
    if (available.length < 3) { nav.hidden = true; return; }
    nav.hidden = false;
    for (const [key, label] of available) {
      nav.append(h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(state.filter === key),
        onclick: () => { state.filter = key; renderFilters(); renderFeed(); },
      }, label));
    }
  }

  function renderFeed() {
    const posts = state.posts.filter((p) => state.filter === 'all' || categories(p).has(state.filter));
    $('#feed').replaceChildren(...posts.map(renderPost));
  }

  function fileTile(file, label) {
    return h('a', { class: 'file-tile', href: file.url, download: file.name || '' },
      h('strong', null, file.name || 'קובץ'),
      h('span', null, label));
  }

  // One photo: shown whole. Several: a strip you swipe through, with a counter.
  function renderImages(images) {
    const slides = images.map((file, i) => {
      const img = h('img', { src: file.previewUrl || file.url, alt: '', loading: 'lazy', decoding: 'async' });
      const button = h('button', {
        type: 'button', class: 'slide', 'aria-label': `תמונה ${i + 1} מתוך ${images.length}`,
        onclick: () => openLightbox(images, i),
      }, img);
      img.addEventListener('error', () => button.replaceWith(fileTile(file, 'הורדת התמונה')), { once: true });
      return button;
    });
    if (images.length === 1) return h('div', { class: 'gallery single' }, slides);

    const strip = h('div', { class: 'strip' }, slides);
    const counter = h('span', { class: 'counter' }, `1 / ${images.length}`);
    const dots = h('div', { class: 'dots', 'aria-hidden': 'true' }, images.map((_, i) => h('span', { class: i ? '' : 'on' })));
    strip.addEventListener('scroll', () => {
      const i = Math.round(Math.abs(strip.scrollLeft) / strip.clientWidth);
      counter.textContent = `${i + 1} / ${images.length}`;
      [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
    }, { passive: true });
    return h('div', { class: 'gallery many' }, strip, counter, dots);
  }

  function renderVideo(file) {
    const video = h('video', {
      controls: true,
      playsinline: true,
      preload: file.previewUrl ? 'none' : 'metadata',
      poster: file.previewUrl,
      src: file.previewUrl ? file.url : `${file.url}#t=0.1`,
    });
    video.addEventListener('error', () => video.replaceWith(fileTile(file, 'הורדת הסרטון')), { once: true });
    return h('div', { class: 'video' }, video);
  }

  function renderAudio(file) {
    return h('div', { class: 'audio' }, h('audio', { controls: true, preload: 'metadata', src: file.url }));
  }

  function renderPost(post) {
    const byType = (t) => post.files.filter((f) => f.type === t);
    const images = byType('image');
    const media = [
      images.length ? renderImages(images) : null,
      ...byType('video').map(renderVideo),
      ...byType('audio').map(renderAudio),
    ].filter(Boolean);
    const classes = ['card'];
    if (media.length) classes.push('has-media');
    if (post.text) classes.push('has-text');

    return h('article', { class: classes.join(' '), 'data-id': post.id },
      h('header', { class: 'card-head' },
        h('div', { class: 'who' },
          post.name ? h('span', { class: 'author' }, post.name) : null,
          h('time', { datetime: post.createdAt }, fmtDate(post.createdAt)),
          post.visibility === 'family' ? h('span', { class: 'badge' }, icons.lock(), 'משפחה בלבד') : null),
        canEdit(post) ? h('button', {
          type: 'button', class: 'edit-btn', onclick: () => openEditor(post),
        }, icons.edit(), 'עריכה') : null),
      h('div', { class: 'card-body' },
        media.length ? h('div', { class: 'card-media' }, media) : null,
        post.text ? h('p', { class: 'text' }, post.text) : null));
  }

  // ---------- dialogs (shared) ----------

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { dialog.close(); return; }
      if (e.target === dialog && dialog.classList.contains('small')) dialog.close();
    });
  }

  function showError(el, message) {
    el.textContent = message || '';
    el.hidden = !message;
    if (message) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- adding and editing a memory ----------

  const compose = $('#compose');
  const composeForm = $('#compose-form');
  const composeError = $('#compose-error');
  const fileInput = $('#f-files');
  const attachmentList = $('#attachments');
  const submitButton = $('#compose-submit');
  // New files: { id, file, type, mime, url }. Files already in an edited post: { id, existing, removed }.
  let attachments = [];
  let editing = null; // the post being edited, or null when adding a new one
  let uploading = false;
  let attachmentSeq = 0;

  const EXT_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', amr: 'audio/amr', flac: 'audio/flac', weba: 'audio/webm',
  };
  const MIME_EXT = {};
  for (const [ext, mime] of Object.entries(EXT_MIME)) if (!MIME_EXT[mime]) MIME_EXT[mime] = ext;
  Object.assign(MIME_EXT, { 'audio/webm': 'weba', 'audio/x-m4a': 'm4a', 'audio/x-wav': 'wav', 'audio/wave': 'wav' });

  /** The storage content type for a file, or null when it is not a photo, video or audio file. */
  function uploadMime(file) {
    const type = (file.type || '').split(';')[0].trim().toLowerCase();
    if (state.uploadTypes.includes(type)) return type;
    const ext = ((/\.([a-z0-9]+)$/i.exec(file.name) || [])[1] || '').toLowerCase();
    const byExt = EXT_MIME[ext];
    if (!byExt || !state.uploadTypes.includes(byExt)) return null;
    // A webm/ogg recording reported as audio stays audio.
    if (type.startsWith('audio/') && byExt.startsWith('video/')) return state.uploadTypes.includes('audio/webm') ? 'audio/webm' : null;
    return byExt;
  }

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  }

  const UPLOAD_ERROR = 'ההעלאה נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.';
  let blobClient = null;

  function sendChunk(url, chunk, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || UPLOAD_ERROR), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error(UPLOAD_ERROR));
      xhr.send(chunk);
    });
  }

  // Google Drive: the file goes to the server in chunks, which passes them on.
  async function putChunked(pathname, body, contentType, onProgress, name, headers) {
    const { chunkSize } = await api('/api/upload/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ pathname, contentType, size: body.size, name }),
    });
    let offset = 0;
    let failures = 0;
    while (offset < body.size) {
      const chunk = body.slice(offset, offset + chunkSize);
      const url = `/api/upload/chunk?pathname=${encodeURIComponent(pathname)}&offset=${offset}`;
      try {
        const result = await sendChunk(url, chunk, (loaded) => onProgress(offset + loaded));
        offset = result.received;
        failures = 0;
        if (result.done) return;
      } catch (err) {
        // Phones drop connections; try the same chunk again a few times.
        failures += 1;
        if (failures > 4 || (err.status >= 400 && err.status < 500)) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      }
    }
  }

  // Uploads go from the browser straight to storage; the server only grants permission.
  async function putFile(pathname, body, contentType, onProgress, { name, headers = {} } = {}) {
    if (state.uploadMode === 'chunked') {
      return putChunked(pathname, body, contentType, onProgress, name || pathname.split('/').pop(), headers);
    }
    if (state.uploadMode === 'local') {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/local-upload?pathname=${encodeURIComponent(pathname)}`);
        xhr.setRequestHeader('Content-Type', contentType);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(data.error || UPLOAD_ERROR));
        };
        xhr.onerror = () => reject(new Error(UPLOAD_ERROR));
        xhr.send(body);
      });
    }
    blobClient ??= import('/vendor/blob-client.js');
    const { upload, uploadPresigned } = await blobClient;
    const send = state.uploadMode === 'presigned' ? uploadPresigned : upload;
    try {
      await send(pathname, body, {
        access: 'private',
        handleUploadUrl: '/api/upload',
        contentType,
        headers,
        multipart: body.size > 64 * 1024 * 1024,
        onUploadProgress: (e) => onProgress(e.loaded),
      });
    } catch (err) {
      console.error('Upload failed:', err);
      throw new Error(UPLOAD_ERROR);
    }
  }

  function resetComposer() {
    for (const a of attachments) if (a.url && !a.existing) URL.revokeObjectURL(a.url);
    attachments = [];
    editing = null;
    $('#f-text').value = '';
    composeForm.querySelector('input[value="public"]').checked = true;
    renderAttachments();
  }

  function openComposer(post) {
    showError(composeError, '');
    if (post) {
      // Editing: fill in what the post has now.
      resetComposer();
      editing = post;
      $('#f-name').value = post.name || '';
      $('#f-text').value = post.text || '';
      composeForm.querySelector(`input[value="${post.visibility}"]`).checked = true;
      attachments = post.files.map((f) => ({ id: ++attachmentSeq, existing: f, removed: false }));
      renderAttachments();
    } else {
      if (editing) resetComposer(); // leave edit mode; keep a draft of a new memory otherwise
      const savedName = store.get('memorial:name');
      if (savedName && !$('#f-name').value) $('#f-name').value = savedName;
    }
    $('#compose-title').textContent = post ? 'עריכת זיכרון' : 'הוספת זיכרון';
    submitButton.textContent = post ? 'שמירה' : 'שליחה';
    $('#edit-extras').hidden = !post;
    $('#copy-edit-link').hidden = !(post && editKeys.get(post.id));
    compose.showModal();
  }

  const openEditor = (post) => openComposer(post);

  $('#open-compose').addEventListener('click', () => openComposer(null));
  compose.addEventListener('cancel', (e) => { if (uploading) e.preventDefault(); });
  compose.addEventListener('close', () => {
    if (recorder) stopRecording();
    if (editing && !uploading) resetComposer();
  });

  fileInput.addEventListener('change', () => {
    showError(composeError, '');
    for (const file of fileInput.files) addAttachment(file);
    fileInput.value = '';
  });

  function addAttachment(file) {
    const mime = uploadMime(file);
    const type = mime && mime.split('/')[0];
    if (!type) {
      showError(composeError, `סוג הקובץ לא נתמך: ${file.name}`);
      return;
    }
    if (!file.size) {
      showError(composeError, `הקובץ ${file.name} ריק.`);
      return;
    }
    if (file.size > state.maxFileMB * 1024 * 1024) {
      showError(composeError, `הקובץ ${file.name} גדול מדי. הגודל המרבי לקובץ: ${fmtSize(state.maxFileMB * 1024 * 1024)}.`);
      return;
    }
    const url = type === 'image' || type === 'audio' ? URL.createObjectURL(file) : null;
    attachments.push({ id: ++attachmentSeq, file, type, mime, url });
    renderAttachments();
  }

  function removeAttachment(id) {
    const a = attachments.find((x) => x.id === id);
    if (!a) return;
    if (a.existing) {
      a.removed = !a.removed; // existing files can be put back until saving
    } else {
      if (a.url) URL.revokeObjectURL(a.url);
      attachments = attachments.filter((x) => x.id !== id);
    }
    renderAttachments();
  }

  function renderAttachments() {
    attachmentList.replaceChildren(...attachments.map((a) => {
      const existing = a.existing;
      const type = existing ? existing.type : a.type;
      const name = existing ? existing.name : a.file.name;
      const size = existing ? existing.size : a.file.size;
      const src = existing ? (existing.previewUrl || (type === 'image' ? existing.url : null)) : a.url;
      const thumb = h('span', { class: 'att-thumb' });
      if (type === 'image' || (existing && existing.previewUrl)) {
        const img = h('img', { src, alt: '' });
        img.addEventListener('error', () => img.replaceWith(icons[type]()), { once: true });
        thumb.append(img);
      } else {
        thumb.append(icons[type]());
      }
      const info = h('span', { class: 'att-info' },
        h('span', { class: 'att-name' }, name),
        h('span', { class: 'att-size' }, a.removed ? 'יוסר בשמירה' : size ? fmtSize(size) : ''),
        type === 'audio' && !a.removed ? h('audio', { controls: true, preload: 'metadata', src: existing ? existing.url : a.url }) : null);
      return h('li', { class: a.removed ? 'removed' : '' }, thumb, info,
        h('button', {
          type: 'button', class: 'icon-btn',
          'aria-label': a.removed ? `החזרת ${name}` : `הסרת ${name}`,
          disabled: uploading, onclick: () => removeAttachment(a.id),
        }, a.removed ? '↺' : '×'));
    }));
  }

  // Smaller copies made in the browser: they load fast in the page, while the
  // original files are kept for the family.
  async function imagePreview(file) {
    const simple = /^image\/(jpeg|png|webp)$/.test(file.type);
    if (file.type === 'image/gif' || (simple && file.size < 350 * 1024)) return null;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    } catch {
      return null; // e.g. iPhone photos in Chrome; the server makes the copy instead
    }
  }

  function videoPoster(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      let done = false;
      const finish = (blob) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        resolve(blob || null);
      };
      const timer = setTimeout(() => finish(null), 8000);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadedmetadata', () => {
        try {
          video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
        } catch {
          finish(null);
        }
      }, { once: true });
      video.addEventListener('seeked', () => {
        try {
          const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
          if (!video.videoWidth) { finish(null); return; }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82);
        } catch {
          finish(null);
        }
      }, { once: true });
      video.addEventListener('error', () => finish(null), { once: true });
      video.src = url;
    });
  }

  function setUploading(on) {
    uploading = on;
    submitButton.disabled = on;
    for (const el of composeForm.querySelectorAll('input, textarea, button')) {
      if (el !== submitButton) el.disabled = on;
    }
    $('#upload-status').hidden = !on;
    if (!on) $('#upload-progress').value = 0;
  }

  function setProgress(fraction, label) {
    $('#upload-progress').value = Math.round(fraction * 100);
    $('#upload-label').textContent = label;
  }

  window.addEventListener('beforeunload', (e) => {
    if (uploading || recorder) { e.preventDefault(); e.returnValue = ''; }
  });

  /** Uploads new attachments as files number `firstIndex`, `firstIndex + 1`, ... of post `postId`. */
  async function uploadNew(postId, newOnes, firstIndex, headers) {
    const uploads = [];
    const files = [];
    for (const [i, a] of newOnes.entries()) {
      const n = firstIndex + i;
      const meta = {
        pathname: `media/${postId}/${n}.${MIME_EXT[a.mime] || 'bin'}`,
        previewPathname: null,
        name: a.file.name,
        mime: a.mime,
        size: a.file.size,
      };
      uploads.push({ pathname: meta.pathname, body: a.file, mime: a.mime, name: a.file.name });
      const preview = a.type === 'image' ? await imagePreview(a.file)
        : a.type === 'video' ? await videoPoster(a.file) : null;
      if (preview) {
        meta.previewPathname = `media/${postId}/${n}.preview.jpg`;
        uploads.push({ pathname: meta.previewPathname, body: preview, mime: 'image/jpeg' });
      }
      files.push(meta);
    }
    const total = uploads.reduce((sum, u) => sum + u.body.size, 0) || 1;
    let sent = 0;
    for (const u of uploads) {
      await putFile(u.pathname, u.body, u.mime, (loaded) => {
        const f = Math.min(1, (sent + loaded) / total);
        setProgress(f, `${Math.round(f * 100)}%`);
      }, { name: u.name, headers });
      sent += u.body.size;
    }
    return files;
  }

  function showPost(post, { scroll }) {
    const visible = post.visibility === 'public' || state.role !== 'guest' || post.canEdit;
    const i = state.posts.findIndex((p) => p.id === post.id);
    if (!visible) state.posts = state.posts.filter((p) => p.id !== post.id);
    else if (i >= 0) state.posts[i] = post;
    else state.posts = [post, ...state.posts];
    state.filter = 'all';
    renderFilters();
    renderFeed();
    const card = visible && $(`.card[data-id="${post.id}"]`);
    if (card) {
      card.classList.add('fresh');
      if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  composeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (uploading) return;
    if (recorder) await stopRecording();
    showError(composeError, '');

    const name = $('#f-name').value.trim();
    const text = $('#f-text').value.trim();
    const visibility = composeForm.querySelector('input[name="visibility"]:checked')?.value || 'public';
    const newOnes = attachments.filter((a) => !a.existing);
    const keptOld = attachments.filter((a) => a.existing && !a.removed);
    if (!text && !newOnes.length && !keptOld.length) {
      showError(composeError, editing ? 'לא נשאר טקסט או קובץ. אפשר למחוק את הזיכרון.' : 'נא לכתוב טקסט או לצרף קובץ.');
      return;
    }

    setUploading(true);
    setProgress(0, 'מכין…');
    try {
      let post;
      if (editing) {
        const addFiles = await uploadNew(editing.id, newOnes, editing.nextIndex, {});
        setProgress(1, 'שומר…');
        ({ post } = await api(`/api/posts/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, text, visibility, addFiles,
            removeFiles: attachments.filter((a) => a.existing && a.removed).map((a) => a.existing.id),
          }),
        }));
      } else {
        const draftId = randomId();
        const files = await uploadNew(draftId, newOnes, 0, {});
        setProgress(1, 'שומר…');
        const result = await api('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId, name, text, visibility, files }),
        });
        post = result.post;
        if (result.editKey) editKeys.set(post.id, result.editKey);
        if (name) store.set('memorial:name', name);
      }
      const wasEditing = Boolean(editing);
      setUploading(false);
      resetComposer();
      compose.close();
      showPost(post, { scroll: !wasEditing });
      if (wasEditing) toast('השינויים נשמרו');
    } catch (err) {
      setUploading(false);
      showError(composeError, err.message);
    }
  });

  $('#delete-post').addEventListener('click', async () => {
    if (!editing || !confirm('למחוק את הזיכרון? לא ניתן לשחזר.')) return;
    try {
      await api(`/api/posts/${editing.id}`, { method: 'DELETE' });
      editKeys.remove(editing.id);
      state.posts = state.posts.filter((p) => p.id !== editing.id);
      resetComposer();
      compose.close();
      renderFilters();
      renderFeed();
      toast('הזיכרון נמחק');
    } catch (err) {
      showError(composeError, err.message);
    }
  });

  // A link that lets the author edit from another phone or computer.
  $('#copy-edit-link').addEventListener('click', async () => {
    if (!editing) return;
    const link = `${location.origin}/?edit=${encodeURIComponent(`${editing.id}~${editKeys.get(editing.id)}`)}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ url: link });
      } else {
        await navigator.clipboard.writeText(link);
        toast('הקישור הועתק');
      }
    } catch {
      prompt('הקישור לעריכה:', link);
    }
  });

  // ---------- voice recording ----------

  let recorder = null;
  let recordStream = null;
  let recordTimer = null;
  let recordStopped = null;
  let recordingCount = 0;

  $('#record-start').addEventListener('click', async () => {
    showError(composeError, '');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showError(composeError, 'הקלטה אינה נתמכת בדפדפן הזה. אפשר להקליט באפליקציה אחרת ולצרף את הקובץ.');
      return;
    }
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showError(composeError, 'אין גישה למיקרופון. יש לאשר גישה בהגדרות הדפדפן.');
      return;
    }
    // AAC plays everywhere (including iPhone); otherwise fall back to Opus.
    const types = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
    const chunks = [];
    recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener('dataavailable', (ev) => { if (ev.data.size) chunks.push(ev.data); });
    recordStopped = new Promise((resolve) => {
      recorder.addEventListener('stop', () => {
        const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        if (chunks.length) {
          recordingCount += 1;
          addAttachment(new File(chunks, `הקלטה ${recordingCount}.${ext}`, { type }));
        }
        recordStream.getTracks().forEach((t) => t.stop());
        recorder = null;
        recordStream = null;
        resolve();
      }, { once: true });
    });

    const started = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    recordTimer = setInterval(tick, 500);
    recorder.start(1000);
    $('#recorder').hidden = false;
    $('#record-start').hidden = true;
  });

  async function stopRecording() {
    if (!recorder) return;
    clearInterval(recordTimer);
    const stopped = recordStopped;
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    $('#recorder').hidden = true;
    $('#record-start').hidden = false;
  }

  $('#record-stop').addEventListener('click', () => stopRecording());

  // ---------- family sign-in ----------

  const loginDialog = $('#login');

  $('#open-login').addEventListener('click', () => {
    showError($('#login-error'), '');
    $('#login-code').value = '';
    loginDialog.showModal();
  });

  async function signIn(code) {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    await load();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#login-code').value.trim();
    if (!code) return;
    try {
      await signIn(code);
      loginDialog.close();
    } catch (err) {
      showError($('#login-error'), err.message);
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    await load();
  });

  // ---------- page settings (admin) ----------

  const settingsDialog = $('#settings');
  const coverInput = $('#s-cover');
  const coverPreview = $('#s-cover-preview');
  let pendingCover = null;
  let removeCover = false;

  function showCoverPreview(src) {
    coverPreview.hidden = !src;
    if (src) coverPreview.src = src; else coverPreview.removeAttribute('src');
    $('#s-cover-remove').hidden = !src;
  }

  $('#open-settings').addEventListener('click', () => {
    showError($('#settings-error'), '');
    $('#s-name').value = state.settings.name;
    $('#s-subtitle').value = state.settings.subtitle || '';
    pendingCover = null;
    removeCover = false;
    showCoverPreview(state.settings.coverUrl);
    settingsDialog.showModal();
  });

  coverInput.addEventListener('change', () => {
    const file = coverInput.files[0];
    coverInput.value = '';
    if (!file) return;
    pendingCover = file;
    removeCover = false;
    showCoverPreview(URL.createObjectURL(file));
  });

  $('#s-cover-remove').addEventListener('click', () => {
    pendingCover = null;
    removeCover = true;
    showCoverPreview(null);
  });

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('#settings-error'), '');
    const button = e.submitter || $('#settings-form button[type="submit"]');
    button.disabled = true;
    try {
      const changes = { name: $('#s-name').value, subtitle: $('#s-subtitle').value };
      if (pendingCover) {
        const resized = await imagePreview(pendingCover);
        const body = resized || pendingCover;
        const mime = resized ? 'image/jpeg' : uploadMime(pendingCover);
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
        if (!ext) throw new Error('נא לבחור תמונה בפורמט JPG או PNG.');
        changes.coverPathname = `cover/${randomId()}.${ext}`;
        await putFile(changes.coverPathname, body, mime, () => {});
      } else if (removeCover) {
        changes.removeCover = true;
      }
      await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      await load();
      settingsDialog.close();
    } catch (err) {
      showError($('#settings-error'), err.message);
    } finally {
      button.disabled = false;
    }
  });

  // ---------- download everything ----------

  const exportDialog = $('#export');

  $('#export-open').addEventListener('click', async () => {
    try {
      const { parts } = await api('/api/export', { cache: 'no-store' });
      if (parts.length === 1) {
        location.href = parts[0].url;
        return;
      }
      $('#export-parts').replaceChildren(...parts.map((part) => h('li', null,
        h('a', { class: 'btn secondary', href: part.url },
          `חלק ${part.number} מתוך ${parts.length}`),
        h('span', { class: 'att-size' }, fmtSize(part.bytes)))));
      exportDialog.showModal();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- photo viewer ----------

  const lightbox = $('#lightbox');
  const lbImg = $('#lb-img');
  let lbList = [];
  let lbIndex = 0;

  function showLightboxImage() {
    const file = lbList[lbIndex];
    lbImg.src = file.previewUrl || file.url;
    const many = lbList.length > 1;
    $('.lb-prev', lightbox).hidden = !many;
    $('.lb-next', lightbox).hidden = !many;
    $('#lb-count').textContent = many ? `${lbIndex + 1} / ${lbList.length}` : '';
  }

  function openLightbox(list, index) {
    lbList = list;
    lbIndex = index;
    showLightboxImage();
    lightbox.showModal();
  }

  function step(delta) {
    if (lbList.length < 2) return;
    lbIndex = (lbIndex + delta + lbList.length) % lbList.length;
    showLightboxImage();
  }

  $('.lb-prev', lightbox).addEventListener('click', () => step(-1));
  $('.lb-next', lightbox).addEventListener('click', () => step(1));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
  lightbox.addEventListener('close', () => lbImg.removeAttribute('src'));
  lightbox.addEventListener('keydown', (e) => {
    // Right-to-left page: the left arrow moves forward.
    if (e.key === 'ArrowLeft') step(1);
    if (e.key === 'ArrowRight') step(-1);
  });
  let touchX = null;
  lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) step(dx > 0 ? 1 : -1);
  });

  // ---------- start ----------

  async function start() {
    // ?k=CODE signs family members in; ?edit=POST~KEY lets an author edit from another device.
    const params = new URLSearchParams(location.search);
    const code = params.get('k');
    const editLink = params.get('edit');
    state.driveFlash = params.get('drive');
    if (code || editLink || state.driveFlash) {
      for (const p of ['k', 'edit', 'drive']) params.delete(p);
      const rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    }
    let editId = null;
    if (editLink && editLink.includes('~')) {
      const [id, key] = editLink.split('~');
      try {
        await api('/api/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, key }),
        });
        editKeys.set(id, key);
        editId = id;
      } catch (err) {
        toast(err.message);
      }
    }
    let signedIn = false;
    if (code) {
      try { await signIn(code); signedIn = true; } catch { /* fall through to a normal load */ }
    }
    if (!signedIn) await load();
    const post = editId && state.posts.find((p) => p.id === editId);
    if (post) openEditor(post);
  }

  start().catch(() => {
    $('#feed').replaceChildren(h('p', { class: 'error', style: 'text-align:center' }, 'לא ניתן לטעון את העמוד. נסו לרענן.'));
  });
})();
