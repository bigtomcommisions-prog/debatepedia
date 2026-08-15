let currentUser = null;
let accountMenuOpen = false;

async function loadCurrentUser(){
  const data = await apiJson('/api/auth/me');
  currentUser = data.user;
  renderAccountControls();
}

function closeAccountMenu(){
  accountMenuOpen = false;
  const menu = document.getElementById('accountMenu');
  if (menu) menu.remove();
  document.removeEventListener('click', onAccountMenuOutsideClick);
}

function onAccountMenuOutsideClick(e){
  const wrap = document.getElementById('accountMenuWrap');
  if (wrap && !wrap.contains(e.target)) closeAccountMenu();
}

function toggleAccountMenu(){
  if (accountMenuOpen) { closeAccountMenu(); return; }
  accountMenuOpen = true;
  const wrap = document.getElementById('accountMenuWrap');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', `
    <div class="account-menu" id="accountMenu">
      <button class="account-menu-item" id="logoutBtn">Log out</button>
      <div class="account-menu-divider"></div>
      <button class="account-menu-item danger" id="deleteAccountBtn">Delete account</button>
    </div>
  `);
  document.getElementById('logoutBtn').onclick = async () => {
    closeAccountMenu();
    await apiJson('/api/auth/logout', {method:'POST'});
    currentUser = null;
    await loadVault();
    renderAccountControls();
    render();
  };
  document.getElementById('deleteAccountBtn').onclick = () => {
    closeAccountMenu();
    showDeleteAccount();
  };
  setTimeout(() => document.addEventListener('click', onAccountMenuOutsideClick), 0);
}

function renderAccountControls(){
  const el=document.getElementById('account'); if(!el)return;
  closeAccountMenu();
  if(currentUser){
    el.innerHTML=`
      <div class="account-menu-wrap" id="accountMenuWrap">
        <button class="account-menu-toggle" id="accountMenuToggle">
          <span class="account-name">${escapeHtml(currentUser.username)}${currentUser.isAdmin?' · admin':''}</span>
          <span class="chev">▾</span>
        </button>
      </div>
    `;
    document.getElementById('accountMenuToggle').onclick = (e) => { e.stopPropagation(); toggleAccountMenu(); };
  } else {
    el.innerHTML=`<button class="account-btn" id="loginBtn">Log in</button><button class="account-btn primary-account" id="registerBtn">Create account</button>`;
    document.getElementById('loginBtn').onclick=()=>showAuth('login');
    document.getElementById('registerBtn').onclick=()=>showAuth('register');
  }
}

function showDeleteAccount(){
  document.body.insertAdjacentHTML('beforeend',`
    <div class="auth-overlay" id="deleteOverlay">
      <div class="auth-card">
        <button class="auth-close" id="deleteClose">×</button>
        <h2>Delete account</h2>
        <p class="delete-account-hint">
          This permanently deletes your account and log-in access. Notes you've
          published stay on the site (just no longer linked to your account);
          any pending submissions of yours are removed. This can't be undone.
        </p>
        <input id="delete-password" type="password" placeholder="Confirm your password">
        <div id="deleteError" class="auth-error"></div>
        <button class="btn btn-delete" id="deleteSubmit">Delete my account</button>
      </div>
    </div>
  `);
  document.getElementById('deleteClose').onclick=()=>document.getElementById('deleteOverlay').remove();
  document.getElementById('deleteSubmit').onclick=async()=>{
    const password = document.getElementById('delete-password').value;
    try{
      await apiJson('/api/auth/account/delete',{method:'POST',body:JSON.stringify({password})});
      document.getElementById('deleteOverlay').remove();
      currentUser=null;
      await loadVault();
      renderAccountControls();
      render();
    } catch(e){
      document.getElementById('deleteError').textContent=e.message;
    }
  };
}

function showAuth(mode){
  const login=mode==='login';
  document.body.insertAdjacentHTML('beforeend',`<div class="auth-overlay" id="authOverlay"><div class="auth-card"><button class="auth-close" id="authClose">×</button><h2>${login?'Log in':'Create account'}</h2>${login?'':'<p class="auth-hint">Create an account to submit contributions.</p>'}<input id="auth-identifier" placeholder="${login?'Username or email':'Username'}">${login?'':'<input id="auth-email" type="email" placeholder="Email (anything with an @)">'}<input id="auth-password" type="password" placeholder="Password"><div id="authError" class="auth-error"></div><button class="btn btn-primary" id="authSubmit">${login?'Log in':'Create account'}</button><button class="auth-switch" id="authSwitch">${login?'Need an account? Create one':'Already have an account? Log in'}</button></div></div>`);
  document.getElementById('authClose').onclick=()=>document.getElementById('authOverlay').remove();
  document.getElementById('authSwitch').onclick=()=>{document.getElementById('authOverlay').remove();showAuth(login?'register':'login');};
  document.getElementById('authSubmit').onclick=async()=>{
    const payload=login?{identifier:document.getElementById('auth-identifier').value,password:document.getElementById('auth-password').value}:{username:document.getElementById('auth-identifier').value,email:document.getElementById('auth-email').value,password:document.getElementById('auth-password').value};
    try{const data=await apiJson(`/api/auth/${mode}`,{method:'POST',body:JSON.stringify(payload)});currentUser=data.user;document.getElementById('authOverlay').remove();renderAccountControls();await loadVault();render();}
    catch(e){document.getElementById('authError').textContent=e.message;}
  };
}
