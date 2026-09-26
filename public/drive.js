// "Chat storage" panel: connect Google Drive, pick the folder chats are saved in.
import { $, escapeHtml } from '/lib.js';

async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

export const driveApi = {
  status: () => api('/api/drive/status'),
  listChats: () => api('/api/drive/chats').then((d) => d.chats),
  saveChat: (chat) => api(`/api/drive/chats/${encodeURIComponent(chat.id)}`, { method: 'PUT', body: JSON.stringify(chat) }),
  deleteChat: (id) => api(`/api/drive/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

// `beforeChange` runs before anything that reloads the page (so unsaved chats get flushed).
export function initDrive({ beforeChange } = {}) {
  const dialog = $('drive');
  const body = $('drive-body');
  let status = null;

  const reload = async () => { await beforeChange?.(); location.reload(); };

  function message(text, kind = 'err') {
    const p = document.createElement('p');
    p.className = `drive-msg ${kind}`;
    p.textContent = text;
    body.querySelector('.drive-msg')?.remove();
    body.prepend(p);
  }

  function renderSetup() {
    body.innerHTML = `
      <p>Save your chats to a folder in <strong>your</strong> Google Drive instead of this computer. You can open,
      download or back up the chat files from Drive at any time.</p>
      <p class="drive-sub">Google needs a free "OAuth client" that belongs to you. This is a one-time setup, about 5 minutes:</p>
      <ol class="drive-steps">
        <li>Open the <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project (any name, e.g. "Edean").</li>
        <li>Turn on the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Google Drive API</a> for that project.</li>
        <li>Open <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">Google Auth Platform</a>, click <em>Get started</em>, choose <em>External</em>, then under <em>Audience</em> add your Google address as a <em>test user</em>.</li>
        <li>Go to <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Clients</a> → <em>Create client</em> → application type <strong>Desktop app</strong>.</li>
        <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the boxes below.</li>
      </ol>
      <form class="drive-form" id="drive-creds">
        <label>Client ID <input name="clientId" required autocomplete="off" spellcheck="false" placeholder="1234567890-abc….apps.googleusercontent.com"></label>
        <label>Client secret <input name="clientSecret" required autocomplete="off" spellcheck="false" type="password" placeholder="GOCSPX-…"></label>
        <div class="drive-actions"><button class="btn" type="submit">Save and continue</button></div>
      </form>
      <p class="drive-sub">These stay on this computer, in your Edean settings folder. Your chats never pass through anyone else.</p>`;
    body.querySelector('#drive-creds').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        status = await api('/api/drive/credentials', { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) });
        render();
      } catch (err) { message(err.message); }
    };
  }

  function renderSignIn() {
    body.innerHTML = `
      <p>Sign in with the Google account whose Drive should hold your chats. Edean only asks for access to
      <strong>files it creates</strong>, so it can't see anything else in your Drive.</p>
      <div class="drive-actions">
        ${status.credentialsFromEnv ? '' : '<button class="btn ghost" type="button" id="drive-change-creds">Change OAuth client</button>'}
        <a class="btn" href="/api/drive/auth" id="drive-signin">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          Sign in with Google
        </a>
      </div>
      <p class="drive-sub">Google will say the app "hasn't been verified" because it's your own private app. Choose <em>Continue</em>.</p>`;
    body.querySelector('#drive-change-creds')?.addEventListener('click', renderSetup);
  }

  async function renderFolderPicker(canCancel) {
    body.innerHTML = `
      <p>Signed in as <strong>${escapeHtml(status.email || 'your Google account')}</strong>. Choose the folder your chats are saved in.</p>
      <form class="drive-form" id="drive-new-folder">
        <label>New folder in your Drive
          <span class="drive-row"><input name="name" value="Edean Chats" required maxlength="120"><button class="btn" type="submit">Create and use</button></span>
        </label>
      </form>
      <div class="drive-folders" id="drive-folders"><p class="drive-sub">Looking for folders Edean made before…</p></div>
      <div class="drive-actions">
        ${canCancel ? '<button class="btn ghost" type="button" id="drive-cancel">Cancel</button>' : ''}
        <button class="btn ghost danger-text" type="button" id="drive-disconnect">Disconnect</button>
      </div>`;
    body.querySelector('#drive-cancel')?.addEventListener('click', render);
    body.querySelector('#drive-disconnect').onclick = disconnect;
    body.querySelector('#drive-new-folder').onsubmit = async (e) => {
      e.preventDefault();
      await useFolder({ name: new FormData(e.target).get('name') });
    };
    const list = body.querySelector('#drive-folders');
    try {
      const { folders } = await api('/api/drive/folders');
      if (!folders.length) { list.innerHTML = ''; return; }
      list.innerHTML = '<p class="drive-sub">Or use a folder Edean created before:</p>';
      for (const f of folders) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'drive-folder';
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span></span>';
        b.lastChild.textContent = f.name;
        if (status.folder?.id === f.id) b.classList.add('current');
        b.onclick = () => useFolder({ id: f.id });
        list.appendChild(b);
      }
    } catch (err) { list.innerHTML = ''; message(err.message); }
  }

  function renderConnected() {
    body.innerHTML = `
      <div class="drive-connected">
        <span class="light green" aria-hidden="true"></span>
        <div>
          <div class="drive-folder-name"></div>
          <div class="drive-sub">Google Drive · ${escapeHtml(status.email)}</div>
        </div>
        <a class="btn ghost small" target="_blank" rel="noopener noreferrer" href="${escapeHtml(status.folder.link || `https://drive.google.com/drive/folders/${status.folder.id}`)}">Open in Drive</a>
      </div>
      <p>New and updated chats are saved to this folder as <code>.json</code> files, one per chat, and are not kept on this computer.
      Deleted chats go to Drive's trash, where they can be restored for 30 days.</p>
      <div class="drive-actions">
        <button class="btn ghost danger-text" type="button" id="drive-disconnect">Disconnect</button>
        <button class="btn ghost" type="button" id="drive-change-folder">Change folder</button>
      </div>`;
    body.querySelector('.drive-folder-name').textContent = status.folder.name;
    body.querySelector('#drive-disconnect').onclick = disconnect;
    body.querySelector('#drive-change-folder').onclick = () => renderFolderPicker(true);
  }

  async function useFolder(choice) {
    try {
      await api('/api/drive/folder', { method: 'POST', body: JSON.stringify(choice) });
      await reload();
    } catch (err) { message(err.message); }
  }

  async function disconnect() {
    if (!confirm('Disconnect Google Drive? Your chats stay in your Drive folder, but Edean will stop loading and saving them there until you reconnect.')) return;
    try {
      await api('/api/drive/disconnect', { method: 'POST', body: '{}' });
      await reload();
    } catch (err) { message(err.message); }
  }

  function render() {
    if (!status) { body.innerHTML = '<p class="drive-sub">Loading…</p>'; return; }
    if (!status.configured) renderSetup();
    else if (!status.connected) renderSignIn();
    else if (!status.folder) renderFolderPicker(false);
    else renderConnected();
  }

  async function open(note) {
    if (!dialog.open) dialog.showModal();
    status = null;
    render();
    try {
      status = await api('/api/drive/status');
      render();
    } catch (err) { body.innerHTML = ''; message(err.message); }
    if (note) message(note.text, note.kind);
  }

  $('close-drive').onclick = () => dialog.close();
  return { open };
}
