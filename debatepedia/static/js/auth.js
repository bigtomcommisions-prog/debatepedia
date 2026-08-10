let currentUser = null;

async function loadCurrentUser(){
  const data = await apiJson('/api/auth/me');
  currentUser = data.user;
  renderAccountControls();
}

function renderAccountControls(){
  const el=document.getElementById('account'); if(!el)return;
  if(currentUser){
    el.innerHTML=`<span class="account-name">${escapeHtml(currentUser.username)}${currentUser.isAdmin?' · admin':''}</span><button class="account-btn" id="logoutBtn">Log out</button>`;
    document.getElementById('logoutBtn').onclick=async()=>{await apiJson('/api/auth/logout',{method:'POST'});currentUser=null;await loadVault();renderAccountControls();render();};
  } else {
    el.innerHTML=`<button class="account-btn" id="loginBtn">Log in</button><button class="account-btn primary-account" id="registerBtn">Create account</button>`;
    document.getElementById('loginBtn').onclick=()=>showAuth('login');
    document.getElementById('registerBtn').onclick=()=>showAuth('register');
  }
}

function showAuth(mode){
  const login=mode==='login';
  document.body.insertAdjacentHTML('beforeend',`<div class="auth-overlay" id="authOverlay"><div class="auth-card"><button class="auth-close" id="authClose">×</button><h2>${login?'Log in':'Create account'}</h2>${login?'':'<p class="auth-hint">Create an account to submit contributions.</p>'}<input id="auth-identifier" placeholder="${login?'Username':'Username'}">${login?'':''}<input id="auth-password" type="password" placeholder="Password"><div id="authError" class="auth-error"></div><button class="btn btn-primary" id="authSubmit">${login?'Log in':'Create account'}</button><button class="auth-switch" id="authSwitch">${login?'Need an account? Create one':'Already have an account? Log in'}</button></div></div>`);
  document.getElementById('authClose').onclick=()=>document.getElementById('authOverlay').remove();
  document.getElementById('authSwitch').onclick=()=>{document.getElementById('authOverlay').remove();showAuth(login?'register':'login');};
  document.getElementById('authSubmit').onclick=async()=>{
    const payload=login?{identifier:document.getElementById('auth-identifier').value,password:document.getElementById('auth-password').value}:{username:document.getElementById('auth-identifier').value,email:document.getElementById('auth-email').value,password:document.getElementById('auth-password').value};
    try{const data=await apiJson(`/api/auth/${mode}`,{method:'POST',body:JSON.stringify(payload)});currentUser=data.user;document.getElementById('authOverlay').remove();renderAccountControls();await loadVault();render();}
    catch(e){document.getElementById('authError').textContent=e.message;}
  };
}

