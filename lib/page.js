'use strict';

// The page shell. Kept in a JS module so it is always bundled with the server
// function; {{...}} placeholders are filled in by server.js.

module.exports = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>{{NAME}}</title>
<meta property="og:title" content="{{NAME}}">
<meta property="og:type" content="website">
{{OG_IMAGE}}
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;500;600&family=Frank+Ruhl+Libre:wght@400;500&display=swap">
<link rel="stylesheet" href="/style.css?v={{V}}">
</head>
<body>

<!-- Wide screens: two halves, nothing scrolls but the memories window.
     Phones: one column; the side's parts are placed around the feed. -->
<!-- Gear (top right): family sign-in, and for members/admin the rest of the options -->
<div class="gear-wrap">
  <button type="button" id="gear" class="gear" aria-label="הגדרות" aria-haspopup="menu" aria-expanded="false" aria-controls="gear-menu" hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  </button>
  <div id="gear-menu" class="gear-menu" role="menu" hidden>
    <button type="button" role="menuitem" id="open-login" class="menu-item" hidden>כניסת משפחה</button>
    <button type="button" role="menuitem" id="open-settings" class="menu-item" hidden>עריכת עמוד</button>
    <button type="button" role="menuitem" id="export-open" class="menu-item" hidden>הורדת הכל</button>
    <div id="drive-menu" class="menu-note" hidden></div>
    <button type="button" role="menuitem" id="logout" class="menu-item" hidden>יציאה</button>
  </div>
</div>

<div class="layout">
  <aside class="side">
    <header class="hero">
      <img id="portrait" class="portrait" alt="" {{COVER}}>
      <h1 id="name">{{NAME}}</h1>
      <p id="subtitle" class="subtitle" {{SUBTITLE_HIDDEN}}>{{SUBTITLE}}</p>
      <p id="about" class="about" {{ABOUT_HIDDEN}}>{{ABOUT}}</p>
      <div id="drive-box" class="drive-box" hidden></div>
    </header>

    <div class="compose-bar">
      <button type="button" id="open-compose" class="btn primary">הוספת זיכרון</button>
    </div>

  </aside>

  <section class="panel" aria-label="זיכרונות">
    <nav id="filters" class="filters" aria-label="סינון"></nav>
    <main id="feed" class="feed"></main>
  </section>
</div>

<!-- Add a memory -->
<dialog id="compose" class="sheet" aria-labelledby="compose-title">
  <form id="compose-form" novalidate>
    <div class="sheet-head">
      <h2 id="compose-title">הוספת זיכרון</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגירה">×</button>
    </div>

    <label class="field">
      <span>שם</span>
      <input id="f-name" type="text" maxlength="80" autocomplete="name">
    </label>

    <label class="field">
      <span>טקסט</span>
      <textarea id="f-text" rows="6" maxlength="20000"></textarea>
    </label>

    <div class="attach-row">
      <label class="btn secondary file-btn">
        <input id="f-files" type="file" accept="image/*,video/*,audio/*" multiple>
        <span>תמונות, סרטונים וקבצי שמע</span>
      </label>
      <button type="button" id="record-start" class="btn secondary">הקלטה</button>
      <button type="button" id="link-start" class="btn secondary">קישור</button>
    </div>

    <div id="link-row" class="link-row" hidden>
      <input id="f-link" type="url" inputmode="url" autocomplete="off" placeholder="הדבקת קישור (למשל ליוטיוב)" aria-label="קישור">
      <button type="button" id="link-add" class="btn secondary">הוספה</button>
    </div>

    <div id="recorder" class="recorder" hidden>
      <span class="rec-dot" aria-hidden="true"></span>
      <span id="rec-time" class="rec-time">0:00</span>
      <button type="button" id="record-stop" class="btn secondary">עצירה</button>
    </div>

    <ul id="attachments" class="attachments"></ul>

    <fieldset class="visibility">
      <legend>מי יכול לראות</legend>
      <label><input type="radio" name="visibility" value="public" checked> כולם</label>
      <label><input type="radio" name="visibility" value="family"> המשפחה בלבד</label>
    </fieldset>

    <div id="upload-status" class="upload-status" hidden>
      <progress id="upload-progress" max="100" value="0"></progress>
      <span id="upload-label"></span>
    </div>
    <p id="compose-error" class="error" role="alert" hidden></p>

    <div id="edit-extras" class="edit-extras" hidden>
      <button type="button" id="copy-edit-link" class="link">קישור לעריכה ממכשיר אחר</button>
      <button type="button" id="delete-post" class="link danger">מחיקת הזיכרון</button>
    </div>

    <div class="sheet-actions">
      <button type="submit" id="compose-submit" class="btn primary">שליחה</button>
      <button type="button" class="btn ghost" data-close>ביטול</button>
    </div>
  </form>
</dialog>

<!-- Family / admin sign-in -->
<dialog id="login" class="sheet small" aria-labelledby="login-title">
  <form id="login-form" novalidate>
    <div class="sheet-head">
      <h2 id="login-title">כניסת משפחה</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגירה">×</button>
    </div>
    <label class="field">
      <span>קוד</span>
      <input id="login-code" type="password" autocomplete="current-password" required>
    </label>
    <p id="login-error" class="error" role="alert" hidden></p>
    <div class="sheet-actions">
      <button type="submit" class="btn primary">כניסה</button>
      <button type="button" class="btn ghost" data-close>ביטול</button>
    </div>
  </form>
</dialog>

<!-- Page settings (admin) -->
<dialog id="settings" class="sheet small" aria-labelledby="settings-title">
  <form id="settings-form" novalidate>
    <div class="sheet-head">
      <h2 id="settings-title">עריכת עמוד</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגירה">×</button>
    </div>
    <label class="field">
      <span>שם</span>
      <input id="s-name" type="text" maxlength="120" required>
    </label>
    <label class="field">
      <span>שורה מתחת לשם (לא חובה)</span>
      <input id="s-subtitle" type="text" maxlength="200">
    </label>
    <label class="field">
      <span>טקסט נוסף מתחת (לא חובה)</span>
      <textarea id="s-about" rows="4" maxlength="2000"></textarea>
    </label>
    <div class="field">
      <span>תמונה</span>
      <div class="cover-edit">
        <img id="s-cover-preview" alt="" hidden>
        <div class="cover-buttons">
          <label class="btn secondary file-btn">
            <input id="s-cover" type="file" accept="image/jpeg,image/png,image/webp">
            <span>בחירת תמונה</span>
          </label>
          <button type="button" id="s-cover-remove" class="link danger" hidden>הסרת התמונה</button>
        </div>
      </div>
    </div>
    <p id="settings-error" class="error" role="alert" hidden></p>
    <div class="sheet-actions">
      <button type="submit" class="btn primary">שמירה</button>
      <button type="button" class="btn ghost" data-close>ביטול</button>
    </div>
  </form>
</dialog>

<!-- Download everything, when it is split into parts -->
<dialog id="export" class="sheet small" aria-labelledby="export-title">
  <form method="dialog">
    <div class="sheet-head">
      <h2 id="export-title">הורדת הכל</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגירה">×</button>
    </div>
    <ul id="export-parts" class="export-parts"></ul>
  </form>
</dialog>

<!-- Photo viewer -->
<dialog id="lightbox" class="lightbox" aria-label="תמונה">
  <button type="button" class="lb-close icon-btn" data-close aria-label="סגירה">×</button>
  <button type="button" class="lb-nav lb-prev" aria-label="הקודמת">›</button>
  <figure class="lb-figure">
    <img id="lb-img" alt="">
    <figcaption id="lb-caption" class="lb-caption" hidden></figcaption>
  </figure>
  <button type="button" class="lb-nav lb-next" aria-label="הבאה">‹</button>
  <span id="lb-count" class="lb-count"></span>
</dialog>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

<script src="/app.js?v={{V}}" defer></script>
</body>
</html>
`;
