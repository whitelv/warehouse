  const API = 'https://warehouse-app-t4op.onrender.com';
  let productsCache = {};
  let zxingReader = null;
  let cameraStream = null;
  let currentSession = null;

  // ── Сесія ────────────────────────────────────────────
  function isAuthenticated() {
    return !!(currentSession && currentSession.rfid);
  }

  function getActivePageName() {
    const active = document.querySelector('.page.active');
    return active ? active.id.replace('page-', '') : 'products';
  }

  async function checkSession() {
    try {
      const res = await fetch(API + '/session/');
      const data = await res.json();
      if (data.rfid) {
        currentSession = data;
        updateSessionUI(data);
      } else {
        currentSession = null;
        updateSessionUI(null);
      }
    } catch(e) {
      currentSession = null;
      updateSessionUI(null);
    }
    return currentSession;
  }

  let loginPoll = null;

  function updateSessionUI(session) {
    const info = document.getElementById('session-info');
    const topbarBtn = document.getElementById('topbar-login-btn');
    const isAdmin = session && session.role === 'admin';
    const isAuth = !!(session && session.rfid);

    if (isAuth) {
      const roleLabel = isAdmin ? 'Адміністратор' : 'Комірник';
      info.textContent = `${session.name} (${roleLabel})`;
      info.style.color = isAdmin ? '#d97706' : '#059669';
      if (topbarBtn) { topbarBtn.textContent = 'Вийти'; topbarBtn.className = 'btn btn-danger'; }
    } else {
      info.textContent = 'Не авторизовано';
      info.style.color = 'rgba(255,255,255,0.6)';
      if (topbarBtn) { topbarBtn.textContent = 'Увійти'; topbarBtn.className = 'btn btn-outline'; }
    }

    document.getElementById('nav-workers').style.display = isAdmin ? '' : 'none';
    document.querySelectorAll('.admin-only').forEach(el => { el.disabled = !isAdmin; });
    document.querySelectorAll('.auth-only').forEach(el => { el.disabled = !isAuth; });

    if (!isAuth) {
      showProductsAuthRequired();
      showHistoryAuthRequired();
    }
  }

  function refreshProtectedPage() {
    const page = getActivePageName();
    if (page === 'products') {
      if (isAuthenticated()) loadProducts();
      else showProductsAuthRequired();
    }
    if (page === 'history') {
      if (isAuthenticated()) loadHistory();
      else showHistoryAuthRequired();
    }
  }

  async function handleLoginLogout() {
    if (currentSession && currentSession.rfid) {
      // Logout
      if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
      await fetch(API + '/session/logout/', { method: 'POST' });
      await fetch(API + '/rfid/login-mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active: false}) });
      sendOLED("Scan RFID", "to login");
      currentSession = null;
      updateSessionUI(null);
      refreshProtectedPage();
      return;
    }

    // Already waiting for card?
    if (loginPoll) {
      clearInterval(loginPoll);
      loginPoll = null;
      const topbarBtn = document.getElementById('topbar-login-btn');
      if (topbarBtn) { topbarBtn.textContent = 'Увійти'; topbarBtn.className = 'btn btn-outline'; }
      document.getElementById('session-info').textContent = 'Не авторизовано';
      document.getElementById('session-info').style.color = 'var(--text3)';
      await fetch(API + '/rfid/login-mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active: false}) });
      sendOLED("Scan RFID", "to login");
      return;
    }

    // Start login — show waiting state
    const topbarBtn = document.getElementById('topbar-login-btn');
    if (topbarBtn) { topbarBtn.textContent = 'Скасувати...'; topbarBtn.className = 'btn btn-outline'; }
    document.getElementById('session-info').textContent = 'Прикладіть картку до ESP32...';
    document.getElementById('session-info').style.color = 'var(--accent)';
    await fetch(API + '/rfid/login-mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active: true}) });
    sendOLED("Scan RFID", "to login");

    let elapsed = 0;
    loginPoll = setInterval(async () => {
      elapsed += 1500;
      const res = await fetch(API + '/session/');
      const data = await res.json();
      if (data.rfid) {
        clearInterval(loginPoll);
        loginPoll = null;
        await fetch(API + '/rfid/login-mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active: false}) });
        currentSession = data;
        updateSessionUI(data);
        refreshProtectedPage();
        sendOLED("Access Granted", toLatин(data.name), "Use website");
        showAlert('alert-area', `✅ Вхід виконано: ${data.name}`, 'success');
      } else if (elapsed >= 90000) {
        clearInterval(loginPoll);
        loginPoll = null;
        await fetch(API + '/rfid/login-mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active: false}) });
        updateSessionUI(null);
        sendOLED("Scan RFID", "to login");
        showAlert('alert-area', '⏱ Час очікування вичерпано. Спробуйте ще раз.', 'warning');
      }
    }, 1500);
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    ['scanner-video', 'qr-video', 'weigh-scanner-video', 'out-scanner-video'].forEach(id => {
      const v = document.getElementById(id);
      if (v) { v.srcObject = null; v.style.display = 'none'; }
    });
    if (zxingReader) {
      try { zxingReader.reset(); } catch(e) {}
    }
  }

  async function startCamera(videoId, callback) {
    stopCamera();
    const video = document.getElementById(videoId);
    video.style.display = 'none';
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });

      const track = cameraStream.getVideoTracks()[0];
      const settings = track.getSettings();
      if (settings.facingMode === 'user') {
        video.style.transform = 'scaleX(-1)';
      } else {
        video.style.transform = '';
      }

      video.srcObject = cameraStream;
      await video.play();
      video.style.display = 'block';
      if (!zxingReader) zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromStream(cameraStream, video, (result, err) => {
        if (result) {
          callback(result.getText());
        }
      });
    } catch(e) {
      video.style.display = 'none';
      return 'Помилка камери: ' + e.message;
    }
    return null;
  }

  function stopZxing(videoId) { stopCamera(); }

  // ── Навігація ────────────────────────────────────────
  function showPage(name, el) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    if (el) el.classList.add('active');

    const titles = { products: 'Товари', history: 'Журнал операцій', weighing: 'Зважування', outgoing: 'Витрата', workers: 'Працівники' };
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = titles[name] || name;

    if (name === 'products') {
      if (isAuthenticated()) loadProducts();
      else showProductsAuthRequired();
    }
    if (name === 'history') {
      if (isAuthenticated()) loadHistory();
      else showHistoryAuthRequired();
    }
    if (name === 'workers')   loadWorkers();

    closeSidebar();
  }

  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('visible');
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
  }

  // ── Toast ─────────────────────────────────────────────
  function showAlert(containerId, msg, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 280);
    }, 4000);
  }

  // ── Утиліти ──────────────────────────────────────────
  function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts + 'Z');
    return d.toLocaleDateString('uk-UA') + ' ' + d.toLocaleTimeString('uk-UA', {hour:'2-digit',minute:'2-digit'});
  }

  // ── ТОВАРИ ───────────────────────────────────────────
  function showProductsAuthRequired() {
    productsCache = {};
    const statsGrid = document.getElementById('stats-grid');
    const tbody = document.getElementById('products-tbody');
    if (statsGrid) {
      statsGrid.innerHTML = '<div class="loading">Потрібна авторизація</div>';
    }
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">Потрібна авторизація</td></tr>';
    }
  }

  async function loadProducts() {
    if (!isAuthenticated()) {
      showProductsAuthRequired();
      return;
    }

    const statsRes = await fetch(API + '/stats/');
    if (statsRes.status === 401) {
      currentSession = null;
      updateSessionUI(null);
      return;
    }
    if (statsRes.ok) {
      const data = await statsRes.json();
      document.getElementById('stats-grid').innerHTML = `
        <div class="stat-card">
          <div class="stat-card-icon blue">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#163252" stroke-width="2">
              <path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
            </svg>
          </div>
          <div class="val">${data.total_products}</div>
          <div class="lbl">Товарів у базі</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-icon orange">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#ea580c" stroke-width="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
          </div>
          <div class="val">${data.total_operations}</div>
          <div class="lbl">Операцій виконано</div>
        </div>
        <div class="stat-card ${data.low_stock_count > 0 ? 'warn' : ''}">
          <div class="stat-card-icon ${data.low_stock_count > 0 ? 'red' : 'blue'}">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="${data.low_stock_count > 0 ? '#dc2626' : '#163252'}" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div class="val">${data.low_stock_count}</div>
          <div class="lbl">Критичних залишків</div>
        </div>
      `;
    }
    const res = await fetch(API + '/products/');
    if (res.status === 401) {
      currentSession = null;
      updateSessionUI(null);
      return;
    }
    const data = await res.json();
    productsCache = {};
    data.forEach(p => productsCache[p.barcode] = p.name);

    const tbody = document.getElementById('products-tbody');
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">Товарів немає. Додайте перший!</td></tr>';
      return;
    }
    const isAdmin = currentSession && currentSession.role === 'admin';
    tbody.innerHTML = data.map(p => {
      const isLow = p.current_stock < p.min_stock;
      const pct = Math.min(100, Math.round((p.current_stock / Math.max(p.min_stock * 2, 1)) * 100));
      const barColor = isLow ? '#dc2626' : pct < 70 ? '#d97706' : '#059669';
      return `
        <tr>
          <td>${p.name}</td>
          <td><code>${p.barcode}</code></td>
          <td>${p.unit_weight} г</td>
          <td>
            <div class="stock-cell">
              <span>${p.current_stock}</span>
              <div class="stock-bar-wrap"><div class="stock-bar-fill" style="width:${pct}%;background:${barColor};"></div></div>
            </div>
          </td>
          <td>${p.min_stock}</td>
          <td>${isLow ? '<span class="badge low">⚠ Мало</span>' : '<span class="badge in">✓ Норма</span>'}</td>
          <td>
            ${isAdmin ? `<button class="btn btn-danger" style="padding:4px 10px;font-size:0.75rem;" onclick="deleteProduct('${p.barcode}')">🗑</button>` : '—'}
          </td>
        </tr>
      `;
    }).join('');
  }

  let qrScannerRunning = false;
  let weighPollInterval = null;
  let weighUnitWeight = 0;
  let weighTare = 0;

  function openAddProduct() {
    document.getElementById('p-barcode').value = '';
    document.getElementById('p-name').value = '';
    document.getElementById('p-unit').value = '';
    document.getElementById('p-min').value = '';
    document.getElementById('qr-status').textContent = 'Натисніть "Сканувати" і наведіть на QR код';
    document.getElementById('qr-status').style.color = '#718096';
    document.getElementById('weigh-status').textContent = 'Покладіть один виріб на ваги і натисніть "Зважити"';
    document.getElementById('weigh-status').style.color = '#718096';
    document.getElementById('qr-video').style.display = 'none';
    document.getElementById('qr-scan-btn').textContent = '📷 Сканувати';
    document.getElementById('weigh-btn').textContent = '⚖️ Зважити';
    document.getElementById('weigh-btn').disabled = false;
    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
    sendOLED("New product", "Scan QR code");
    document.getElementById('modal-product').classList.add('open');
  }

  async function startQRScan() {
    const status = document.getElementById('qr-status');
    const btn = document.getElementById('qr-scan-btn');

    if (cameraStream) {
      stopCamera();
      btn.textContent = '📷 Сканувати';
      status.textContent = 'Натисніть "Сканувати" і наведіть на QR код';
      status.style.color = '#718096';
      sendOLED("New product", "Scan QR code");
      return;
    }

    sendOLED("Scan QR code", "Use phone camera");
    btn.textContent = '⏹ Зупинити';
    status.style.color = '#f6ad55';
    status.textContent = 'Наводьте камеру на QR код...';

    const err = await startCamera('qr-video', (code) => {
      stopCamera();
      document.getElementById('p-barcode').value = code;
      status.style.color = '#68d391';
      status.textContent = '✅ Відскановано: ' + code;
      btn.textContent = '📷 Сканувати';
      sendOLED("QR scanned!", code, "Put item on scale");
    });

    if (err) {
      status.textContent = err;
      status.style.color = '#fc8181';
      btn.textContent = '📷 Сканувати';
    }
  }

  async function startWeighItem() {
    const status = document.getElementById('weigh-status');
    status.style.color = '#f6ad55';
    status.textContent = '⏳ Покладіть один виріб на ваги, чекаю стабілізації...';
    sendOLED("Put 1 item", "on scale, wait...");

    // Використовуємо pollStableWeight для стабільного зважування
    // minWeight = 0.5г (мінімальна вага предмета)
    pollStableWeight(0.5, (avg) => {
      document.getElementById('p-unit').value = avg.toFixed(2);
      status.style.color = '#68d391';
      status.textContent = '✅ Маса одиниці: ' + avg.toFixed(2) + ' г (стабільне значення)';
      sendOLED("Unit: " + avg.toFixed(2) + "g", "Enter name, save");
    }, () => {
      status.style.color = '#fc8181';
      status.textContent = '❌ Час вийшов. Спробуйте ще раз.';
      sendOLED("New product", "Try again");
    }, 'weigh-btn', 'weigh-status');
  }

  async function submitProduct() {
    const body = {
      barcode:     document.getElementById('p-barcode').value.trim(),
      name:        document.getElementById('p-name').value.trim(),
      unit_weight: parseFloat(document.getElementById('p-unit').value),
      min_stock:   parseInt(document.getElementById('p-min').value),
      current_stock: 0
    };
    if (!body.barcode || !body.name || isNaN(body.unit_weight)) {
      showAlert('products-alert', 'Заповніть всі поля!', 'error');
      return;
    }
    const res = await fetch(API + '/products/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (res.ok) {
      closeModal('modal-product');
      showAlert('products-alert', '✅ Товар додано!', 'success');
      loadProducts();
    } else {
      const err = await res.json();
      showAlert('products-alert', '❌ ' + err.detail, 'error');
    }
  }

  async function deleteProduct(barcode) {
    if (!confirm('Видалити товар?')) return;
    await fetch(API + '/products/' + barcode, { method: 'DELETE' });
    loadProducts();
  }

  // ── ІСТОРІЯ ──────────────────────────────────────────
  let allOperations = [];
  let workersCache = {};

  function showHistoryAuthRequired() {
    allOperations = [];
    workersCache = {};
    const tbody = document.getElementById('history-tbody');
    const filterWorker = document.getElementById('filter-worker');
    if (filterWorker) {
      filterWorker.innerHTML = '<option value="">Всі працівники</option>';
    }
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#718096;padding:20px;">Потрібна авторизація</td></tr>';
    }
  }

  async function loadHistory() {
    if (!isAuthenticated()) {
      showHistoryAuthRequired();
      return;
    }

    if (Object.keys(productsCache).length === 0) {
      const res = await fetch(API + '/products/');
      if (res.status === 401) {
        currentSession = null;
        updateSessionUI(null);
        return;
      }
      const data = await res.json();
      data.forEach(p => productsCache[p.barcode] = p.name);
    }

    const wRes = await fetch(API + '/workers/');
    if (wRes.status === 401) {
      currentSession = null;
      updateSessionUI(null);
      return;
    }
    const workers = await wRes.json();
    workersCache = {};
    workers.forEach(w => { workersCache[w.rfid] = w.name; });

    // Populate worker filter
    const filterWorker = document.getElementById('filter-worker');
    const prevWorker = filterWorker.value;
    filterWorker.innerHTML = '<option value="">Всі працівники</option>';
    workers.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.rfid;
      opt.textContent = w.name;
      filterWorker.appendChild(opt);
    });
    filterWorker.value = prevWorker;

    const res = await fetch(API + '/operations/?limit=500');
    if (res.status === 401) {
      currentSession = null;
      updateSessionUI(null);
      return;
    }
    allOperations = await res.json();
    applyHistoryFilter();

  }


  function applyHistoryFilter() {
    const typeFilter = document.getElementById('filter-type').value;
    const workerFilter = document.getElementById('filter-worker').value;
    const dateFilter = document.getElementById('filter-date').value;
    document.getElementById('filter-date').classList.toggle('has-value', !!dateFilter);
    const sortOrder = document.getElementById('filter-sort').value;
    const tbody = document.getElementById('history-tbody');

    let filtered = allOperations.filter(op => {
      if (typeFilter && op.type !== typeFilter) return false;
      if (workerFilter && (op.worker_rfid || '').toUpperCase() !== workerFilter.toUpperCase()) return false;
      if (dateFilter) {
        const opDate = new Date(op.timestamp).toISOString().slice(0, 10);
        if (opDate !== dateFilter) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return sortOrder === 'oldest' ? ta - tb : tb - ta;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#718096;padding:20px;">Операцій не знайдено</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(op => {
      const net = (op.gross_weight - op.tare_weight).toFixed(1);
      const productName = productsCache[op.barcode] || op.barcode;
      const isIn = op.type === 'incoming';
      const rfid = (op.worker_rfid || '').toUpperCase();
      const workerName = workersCache[rfid] || op.worker_rfid || '—';
      return `
        <tr>
          <td>${formatDate(op.timestamp)}</td>
          <td>${productName}</td>
          <td><span class="badge ${isIn ? 'in' : 'out'}">${isIn ? '▲ Прихід' : '▼ Витрата'}</span></td>
          <td>${isIn ? '+' : '-'}${op.quantity} шт</td>
          <td>${isIn ? net + ' г' : '—'}</td>
          <td>${workerName}</td>
        </tr>
      `;
    }).join('');
  }

  function clearHistoryFilters() {
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-worker').value = '';
    document.getElementById('filter-date').value = '';
    document.getElementById('filter-sort').value = 'newest';
    applyHistoryFilter();
  }

  // ── ЗВАЖУВАННЯ ───────────────────────────────────────
  function openWeighing() {
    document.getElementById('w-barcode').value = '';
    document.getElementById('weigh-scan-status').textContent = 'Натисніть "Сканувати" і наведіть на QR код';
    document.getElementById('weigh-scan-status').style.color = '#718096';
    document.getElementById('weigh-scanner-btn').textContent = '📷 Сканувати';
    document.getElementById('weigh-scanner-video').style.display = 'none';
    document.getElementById('weigh-tare').value = '';
    document.getElementById('weigh-gross').value = '';
    document.getElementById('weigh-tare-status').textContent = 'Якщо не маєте даних про тару — поставте пусту коробку і натисніть "Зважити"';
    document.getElementById('weigh-tare-status').style.color = '#718096';
    document.getElementById('weigh-gross-status').textContent = 'Покладіть товар у коробку, поставте на ваги і натисніть "Зважити"';
    document.getElementById('weigh-gross-status').style.color = '#718096';
    document.getElementById('weigh-tare-btn').textContent = '⚖️ Зважити';
    document.getElementById('weigh-tare-btn').disabled = false;
    document.getElementById('weigh-gross-btn').textContent = '⚖️ Зважити';
    document.getElementById('weigh-gross-btn').disabled = false;
    document.getElementById('weigh-live-qty').textContent = '';
    document.getElementById('weigh-send-status').textContent = '';
    document.getElementById('weigh-save-btn').disabled = true;
    weighUnitWeight = 0;
    weighTare = 0;
    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
    sendOLED("Weighing mode", "Scan QR code");
    document.getElementById('modal-weighing').classList.add('open');
  }

  async function startWeighScanner() {
    const status = document.getElementById('weigh-scan-status');
    const btn = document.getElementById('weigh-scanner-btn');

    if (cameraStream) {
      stopCamera();
      btn.textContent = '📷 Сканувати';
      status.textContent = 'Натисніть "Сканувати" і наведіть на QR код';
      status.style.color = '#718096';
      return;
    }

    btn.textContent = '⏹ Зупинити';
    status.style.color = '#f6ad55';
    status.textContent = 'Наводьте камеру на QR код...';

    const err = await startCamera('weigh-scanner-video', (code) => {
      stopCamera();
      document.getElementById('w-barcode').value = code;
      status.style.color = '#68d391';
      status.textContent = '✅ Відскановано: ' + code;
      btn.textContent = '📷 Сканувати';
      sendOLED("QR scanned!", code, "Weigh tare/items");
      loadProductTare(code);
    });

    if (err) {
      status.textContent = err;
      status.style.color = '#fc8181';
      btn.textContent = '📷 Сканувати';
    }
  }

  // Завантажує тару з БД після сканування QR
  async function loadProductTare(barcode) {
    try {
      const res = await fetch(API + '/products/barcode/' + encodeURIComponent(barcode));
      if (!res.ok) return;
      const product = await res.json();
      weighUnitWeight = product.unit_weight || 0;

      const tareInput  = document.getElementById('weigh-tare');
      const tareStatus = document.getElementById('weigh-tare-status');
      const tareBtn    = document.getElementById('weigh-tare-btn');

      if (product.tare_weight && product.tare_weight > 0) {
        weighTare = product.tare_weight;
        tareInput.value         = product.tare_weight.toFixed(1);
        tareStatus.style.color  = '#68d391';
        tareStatus.textContent  = `✅ Тара відома: ${product.tare_weight.toFixed(1)} г (збережено в системі)`;
        tareBtn.textContent     = '🔄 Перезважити';
      } else {
        weighTare = 0;
        tareInput.value         = '';
        tareStatus.style.color  = '#f6ad55';
        tareStatus.textContent  = 'Тара невідома — поставте пусту коробку і натисніть "Зважити"';
        tareBtn.textContent     = '⚖️ Зважити';
      }
    } catch(e) {}
  }

  // Спільна функція стабільного зчитування ваги
  // Адаптивний розкид: для маленьких предметів — точніше, для великих — допускаємо більше
  function pollStableWeight(minWeight, onStable, onTimeout, btnId, statusId) {
    const btn    = btnId ? document.getElementById(btnId) : null;
    const status = statusId ? document.getElementById(statusId) : null;
    if (btn) { btn.textContent = '⏳ Зважую...'; btn.disabled = true; }
    if (status) { status.style.color = '#63b3ed'; status.textContent = '⏳ Поставте товар на ваги та чекайте автоматичного збереження...'; }

    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }

    const stopWeigh = () => {
      fetch(API + '/weight/mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active:false}) });
    };

    // Вмикаємо режим (для OLED ESP32), але не чекаємо — одразу стартуємо опитування
    fetch(API + '/weight/mode/', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active:true}) });

    let attempts = 0;
    let errors   = 0;
    let prev     = null;
    let weightCleared = true;
    const MAX_ATTEMPTS = 400;
    const MAX_ERRORS   = 6;

    weighPollInterval = setInterval(async () => {
      attempts++;
      try {
        const res  = await fetch(API + '/weight/current/');
        const data = await res.json();
        errors = 0;

        const w = parseFloat(data.weight);
        if (!isNaN(w) && w <= minWeight) {
          weightCleared = true;
          prev = null;
        } else if (!isNaN(w) && w > minWeight && weightCleared) {
          if (prev !== null && Math.abs(w - prev) < 3.0) {
            clearInterval(weighPollInterval); weighPollInterval = null;
            stopWeigh();
            if (btn) { btn.textContent = '⚖️ Зважити'; btn.disabled = false; }
            onStable((w + prev) / 2);
            return;
          }
          prev = w;
        }
      } catch(e) {
        errors++;
        if (errors >= MAX_ERRORS) {
          clearInterval(weighPollInterval); weighPollInterval = null;
          if (btn) { btn.textContent = '⚖️ Зважити'; btn.disabled = false; }
          stopWeigh();
          if (status) { status.style.color = '#fc8181'; status.textContent = '❌ Помилка мережі. Спробуйте ще раз.'; }
          if (onTimeout) onTimeout();
        }
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(weighPollInterval); weighPollInterval = null;
        if (btn) { btn.textContent = '⚖️ Зважити'; btn.disabled = false; }
        stopWeigh();
        if (status) { status.style.color = '#fc8181'; status.textContent = '❌ Час вийшов. Спробуйте ще раз.'; }
        if (onTimeout) onTimeout();
      }
    }, 80);
  }

  async function startTareWeigh() {
    const tareStatus = document.getElementById('weigh-tare-status');
    tareStatus.style.color  = '#f6ad55';
    tareStatus.textContent  = '⏳ Поставте пусту коробку на ваги...';
    sendOLED("Put empty box", "on scale");

    pollStableWeight(2, (avg) => {
      weighTare = avg;
      document.getElementById('weigh-tare').value       = avg.toFixed(1);
      document.getElementById('weigh-tare-btn').textContent = '🔄 Перезважити';
      tareStatus.style.color  = '#68d391';
      tareStatus.textContent  = `✅ Тара: ${avg.toFixed(1)} г (збережено в системі)`;
      sendOLED("Tare: " + avg.toFixed(0) + "g", "Add items, weigh");
      // Зберігаємо тару в БД для цього товару
      const barcode = document.getElementById('w-barcode').value.trim();
      if (barcode) {
        fetch(API + '/products/' + encodeURIComponent(barcode), {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ tare_weight: avg })
        });
      }
    }, null, 'weigh-tare-btn', 'weigh-tare-status');
  }

  async function startGrossWeigh() {
    const barcode = document.getElementById('w-barcode').value.trim();
    if (!barcode) {
      showAlert('weighing-alert', 'Спочатку відскануйте або введіть штрихкод!', 'error');
      return;
    }
    // Оновлюємо unit_weight якщо ще не завантажений
    if (!weighUnitWeight) {
      try {
        const pRes = await fetch(API + '/products/barcode/' + encodeURIComponent(barcode));
        if (pRes.ok) { const pData = await pRes.json(); weighUnitWeight = pData.unit_weight || 0; }
      } catch(e) {}
    }
    const grossStatus = document.getElementById('weigh-gross-status');
    grossStatus.style.color  = '#f6ad55';
    grossStatus.textContent  = '⏳ Поставте коробку з товаром на ваги...';
    sendOLED("Put full box", "on scale");

    pollStableWeight(5, (avg) => {
      const qty = weighUnitWeight > 0 ? Math.round(avg / weighUnitWeight) : '?';
      document.getElementById('weigh-gross').value = avg.toFixed(1);
      grossStatus.style.color  = '#68d391';
      grossStatus.textContent  = `✅ Вага: ${avg.toFixed(1)} г`;
      document.getElementById('weigh-live-qty').textContent = `${avg.toFixed(1)} г → ${qty} шт`;
      document.getElementById('weigh-save-btn').disabled = false;
      sendOLED(avg.toFixed(0) + "g", qty + " pcs", "Press Save");
    }, null, 'weigh-gross-btn', 'weigh-gross-status');
  }

  async function submitWeighing() {
    const barcode = document.getElementById('w-barcode').value.trim();
    const gross   = parseFloat(document.getElementById('weigh-gross').value);
    if (!barcode || !gross) {
      showAlert('weighing-alert', 'Спочатку відскануйте QR і зважте товар!', 'error');
      return;
    }
    const qty  = weighUnitWeight > 0 ? Math.round(gross / weighUnitWeight) : 1;
    const rfid = currentSession ? currentSession.rfid : '';
    const res  = await fetch(API + '/operations/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ barcode, quantity: qty, gross_weight: gross, tare_weight: 0, worker_rfid: rfid, type: 'incoming' })
    });
    if (res.ok) {
      const data = await res.json();
      const warn = data.warning ? ' ⚠️ ' + data.warning : '';
      showAlert('weighing-alert', `✅ Збережено: ${qty} шт (${gross.toFixed(1)} г)${warn}`, 'success');
      closeModal('modal-weighing');
      loadProducts();
    } else {
      const err = await res.json();
      showAlert('weighing-alert', '❌ ' + err.detail, 'error');
    }
  }

  async function clearHistory() {
    if (!confirm('Видалити всю історію операцій? Цю дію не можна скасувати.')) return;
    const res = await fetch(API + '/operations/', { method: 'DELETE' });
    if (res.ok) {
      loadHistory();
      loadProducts();
    }
  }

  // ── ВИТРАТА ──────────────────────────────────────────
  function openOutgoing() {
    document.getElementById('out-barcode').value = '';
    document.getElementById('out-qty').value = '1';
    document.getElementById('out-scan-status').textContent = 'Натисніть "Сканувати" і наведіть на QR код';
    document.getElementById('out-scan-status').style.color = '#718096';
    document.getElementById('out-scanner-btn').textContent = '📷 Сканувати';
    document.getElementById('out-scanner-video').style.display = 'none';
    document.getElementById('out-weigh-status').textContent = 'Покладіть залишок товару на ваги і натисніть "Зважити"';
    document.getElementById('out-weigh-status').style.color = '#718096';
    document.getElementById('out-weigh-btn').textContent = '⚖️ Зважити';
    document.getElementById('out-weigh-btn').disabled = false;
    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
    sendOLED("Stock Out", "Scan QR code");
    document.getElementById('modal-outgoing').classList.add('open');
  }

  async function startOutgoingWeigh() {
    const barcode = document.getElementById('out-barcode').value.trim();
    if (!barcode) {
      document.getElementById('out-weigh-status').textContent = '❌ Спочатку відскануйте QR код товару!';
      document.getElementById('out-weigh-status').style.color = '#fc8181';
      return;
    }

    // Отримуємо еталонну масу одиниці товару
    const res = await fetch(API + '/products/barcode/' + barcode);
    if (!res.ok) {
      document.getElementById('out-weigh-status').textContent = '❌ Товар не знайдено в БД!';
      document.getElementById('out-weigh-status').style.color = '#fc8181';
      return;
    }
    const product = await res.json();
    const unitW = product.unit_weight;
    const currentStock = product.current_stock;

    const status = document.getElementById('out-weigh-status');
    status.style.color = '#f6ad55';
    status.textContent = `⏳ Чекаю стабілізації ваги... (одиниця = ${unitW}г, на складі: ${currentStock} шт)`;
    sendOLED("Put items", "wait for stable...");

    // Використовуємо pollStableWeight для стабільного зважування
    pollStableWeight(0.5, (avg) => {
      const qty = Math.round(avg / unitW);
      document.getElementById('out-qty').value = qty;
      status.style.color = '#68d391';
      status.textContent = `✅ Маса: ${avg.toFixed(1)}г → ${qty} шт (на складі: ${currentStock} шт)`;
      if (qty > currentStock) {
        status.style.color = '#fc8181';
        status.textContent += ' ⚠️ Перевищує залишок!';
      }
      sendOLED("Weight: " + avg.toFixed(1) + "g", "Qty: " + qty + " pcs");
    }, () => {
      status.style.color = '#fc8181';
      status.textContent = '❌ Час вийшов. Спробуйте ще раз.';
    }, 'out-weigh-btn', 'out-weigh-status');
  }

  async function startOutgoingScanner() {
    const status = document.getElementById('out-scan-status');
    const btn = document.getElementById('out-scanner-btn');
    if (cameraStream) {
      stopCamera();
      btn.textContent = '📷 Сканувати';
      status.textContent = 'Натисніть "Сканувати" і наведіть на QR код';
      status.style.color = '#718096';
      return;
    }
    btn.textContent = '⏹ Зупинити';
    status.style.color = '#f6ad55';
    status.textContent = 'Наводьте камеру на QR код...';
    const err = await startCamera('out-scanner-video', (code) => {
      stopCamera();
      document.getElementById('out-barcode').value = code;
      status.style.color = '#68d391';
      status.textContent = '✅ Відскановано: ' + code;
      btn.textContent = '📷 Сканувати';
      sendOLED("QR scanned!", code, "Enter qty, save");
    });
    if (err) {
      status.textContent = err; status.style.color = '#fc8181';
      btn.textContent = '📷 Сканувати';
    }
  }

  async function submitOutgoing() {
    const barcode = document.getElementById('out-barcode').value.trim();
    const qty = parseInt(document.getElementById('out-qty').value);
    const rfid = currentSession ? currentSession.rfid : '';
    if (!barcode || !qty) {
      showAlert('outgoing-alert', 'Заповніть всі поля!', 'error');
      return;
    }
    // Перевірка залишку перед відправкою
    try {
      const check = await fetch(API + '/products/barcode/' + barcode);
      if (check.ok) {
        const prod = await check.json();
        if (qty > prod.current_stock) {
          showAlert('outgoing-alert', `❌ Недостатньо товару! На складі: ${prod.current_stock} шт`, 'error');
          return;
        }
      }
    } catch(e) {}
    const res = await fetch(API + '/operations/outgoing/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ barcode, quantity: qty, worker_rfid: rfid })
    });
    if (res.ok) {
      const data = await res.json();
      let msg = `✅ Списано ${qty} шт.`;
      if (data.warning) msg += ' ⚠️ ' + data.warning;
      closeModal('modal-outgoing');
      showAlert('outgoing-alert', msg, data.warning ? 'warning' : 'success');
      loadProducts();
    } else {
      const err = await res.json();
      showAlert('outgoing-alert', '❌ ' + err.detail, 'error');
    }
  }

  // ── RFID сканування для форми працівника ─────────────
  let rfidPollInterval = null;

  function toLatин(str) {
    const map = {
      'А':'A','Б':'B','В':'V','Г':'H','Ґ':'G','Д':'D','Е':'E','Є':'Ye','Ж':'Zh','З':'Z',
      'И':'Y','І':'I','Ї':'Yi','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P',
      'Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh',
      'Щ':'Shch','Ь':'','Ю':'Yu','Я':'Ya',
      'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ye','ж':'zh','з':'z',
      'и':'y','і':'i','ї':'yi','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p',
      'р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
      'щ':'shch','ь':'','ю':'yu','я':'ya'
    };
    return (str || '').split('').map(c => map[c] ?? c).join('');
  }

  function sendOLED(line1, line2 = "", line3 = "") {
    fetch(API + '/oled/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({line1, line2, line3})
    });
  }

  function disableRegisterMode() {
    if (rfidPollInterval) clearInterval(rfidPollInterval);
    rfidPollInterval = null;
    fetch(API + '/rfid/register-mode/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({active: false})
    });
    // Consume any pending RFID so a late poll callback can't send stale OLED
    fetch(API + '/rfid/last/');
  }

  function startRFIDScan() {
    const btn = document.getElementById('rfid-scan-btn');
    const status = document.getElementById('rfid-status');
    const input = document.getElementById('w-rfid');

    // Якщо вже очікуємо — скасовуємо
    if (rfidPollInterval) {
      clearInterval(rfidPollInterval);
      rfidPollInterval = null;
      disableRegisterMode();
      btn.textContent = '🔄 Сканувати';
      btn.disabled = false;
      status.textContent = 'Натисніть "Сканувати" і прикладіть картку';
      status.style.color = '#718096';
      return;
    }

    btn.textContent = '⏹ Скасувати';
    btn.disabled = false;
    status.style.color = '#f6ad55';
    status.textContent = 'Прикладіть картку до зчитувача...';
    input.value = '';

    fetch(API + '/rfid/register-mode/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({active: true})
    });
    sendOLED("Register mode", "Scan new card");

    let attempts = 0;
    rfidPollInterval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(API + '/rfid/last/');
        const data = await res.json();
        if (data.rfid) {
          input.value = data.rfid;
          status.style.color = '#68d391';
          status.textContent = '✅ Картку відскановано!';
          btn.textContent = '🔄 Сканувати';
          btn.disabled = false;
          clearInterval(rfidPollInterval);
          rfidPollInterval = null;
          sendOLED("Card saved!", data.rfid, "Enter name on site");
          fetch(API + '/rfid/register-mode/', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({active: false})
          });
        } else if (attempts > 30) {
          status.style.color = '#fc8181';
          status.textContent = '❌ Час вийшов. Спробуйте ще раз.';
          btn.textContent = '🔄 Сканувати';
          btn.disabled = false;
          disableRegisterMode();
          sendOLED("Scan RFID", "to login");
        }
      } catch (e) {
        clearInterval(rfidPollInterval);
        btn.textContent = '🔄 Сканувати';
        btn.disabled = false;
        disableRegisterMode();
      }
    }, 1000);
  }

  // ── ПРАЦІВНИКИ ───────────────────────────────────────
  async function loadWorkers() {
    const res = await fetch(API + '/workers/');
    const data = await res.json();
    const tbody = document.getElementById('workers-tbody');
    const isAdmin = currentSession && currentSession.role === 'admin';
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#718096;padding:20px;">Працівників немає</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(w => {
      const isAdminRow = w.rfid === 'A7012249';
      const roleLabel = isAdminRow ? 'Адміністратор' : 'Комірник';
      const roleColor = isAdminRow ? '#f6ad55' : '#68d391';
      const deleteBtn = (!isAdminRow && isAdmin)
        ? `<button class="btn btn-danger" style="padding:4px 10px;font-size:0.75rem;" onclick="deleteWorker('${w.rfid}')">🗑</button>`
        : '—';
      return `
        <tr>
          <td>${w.name} <span style="color:${roleColor};font-size:0.78rem;">(${roleLabel})</span></td>
          <td><code>${w.rfid}</code></td>
          <td>${deleteBtn}</td>
        </tr>
      `;
    }).join('');
  }

  async function deleteWorker(rfid) {
    if (!confirm('Видалити працівника?')) return;
    await fetch(API + '/workers/' + rfid, { method: 'DELETE' });
    loadWorkers();
  }

  function openAddWorker() {
    document.getElementById('w-rfid').value = '';
    document.getElementById('w-name').value = '';
    document.getElementById('rfid-status').textContent = 'Натисніть "Сканувати" і прикладіть картку';
    document.getElementById('rfid-status').style.color = '#718096';
    document.getElementById('rfid-scan-btn').textContent = '🔄 Сканувати';
    document.getElementById('rfid-scan-btn').disabled = false;
    if (rfidPollInterval) { clearInterval(rfidPollInterval); rfidPollInterval = null; }
    sendOLED("Register mode", "Scan new card");
    document.getElementById('modal-worker').classList.add('open');
  }

  async function submitWorker() {
    const body = {
      rfid: document.getElementById('w-rfid').value.trim().toUpperCase(),
      name: document.getElementById('w-name').value.trim()
    };
    if (!body.rfid || !body.name) {
      showAlert('workers-alert', 'Заповніть всі поля!', 'error');
      return;
    }
    const res = await fetch(API + '/workers/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (res.ok) {
      closeModal('modal-worker', true);
      showAlert('workers-alert', '✅ Працівника додано!', 'success');
      loadWorkers();
    } else {
      const err = await res.json();
      showAlert('workers-alert', '❌ ' + err.detail, 'error');
    }
  }

  // ── ЗВАЖУВАННЯ ───────────────────────────────────────
  function openWeighing() {
    document.getElementById('w-barcode').value = '';
    document.getElementById('weigh-scan-status').textContent = 'Натисніть "Сканувати" і наведіть на QR код';
    document.getElementById('weigh-scan-status').style.color = '#718096';
    document.getElementById('weigh-scanner-btn').textContent = '📷 Сканувати';
    document.getElementById('weigh-scanner-video').style.display = 'none';
    document.getElementById('weigh-gross').value = '';
    document.getElementById('weigh-gross-btn').textContent = '⚖️ Зважити';
    document.getElementById('weigh-gross-btn').disabled = false;
    document.getElementById('weigh-gross-status').textContent = 'Покладіть товар на ваги і натисніть "Зважити"';
    document.getElementById('weigh-gross-status').style.color = '#718096';
    document.getElementById('weigh-live-qty').textContent = '';
    document.getElementById('weigh-send-status').textContent = '';
    document.getElementById('weigh-save-btn').disabled = true;
    weighUnitWeight = 0;
    weighTare = 0;
    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
    fetch(API + '/weight/mode/', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active:false}) });
    sendOLED("Weighing mode", "Scan QR code");
    document.getElementById('modal-weighing').classList.add('open');
  }

  async function startWeighScanner() {
    const status = document.getElementById('weigh-scan-status');
    const btn = document.getElementById('weigh-scanner-btn');
    if (cameraStream) {
      stopCamera();
      btn.textContent = '📷 Сканувати';
      status.textContent = 'Натисніть "Сканувати" і наведіть на QR код';
      status.style.color = '#718096';
      return;
    }
    btn.textContent = '⏹ Зупинити';
    status.textContent = 'Запуск камери...';
    status.style.color = '#f6ad55';
    const err = await startCamera('weigh-scanner-video', (code) => {
      stopCamera();
      document.getElementById('w-barcode').value = code;
      status.textContent = '✅ Відскановано: ' + code;
      status.style.color = '#68d391';
      btn.textContent = '📷 Сканувати';
      sendOLED("QR scanned!", code, "Press start");
    });
    if (err) {
      status.textContent = err;
      status.style.color = '#fc8181';
      btn.textContent = '📷 Сканувати';
    }
  }

  async function sendWeighBarcode() {
    const barcode = document.getElementById('w-barcode').value.trim();
    if (!barcode) {
      document.getElementById('weigh-send-status').textContent = '❌ Спочатку відскануйте QR код!';
      document.getElementById('weigh-send-status').style.color = '#fc8181';
      return;
    }
    await fetch(API + '/weigh/start/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({barcode})
    });
    sendOLED("Incoming", barcode, "Check ESP32");
    document.getElementById('weigh-send-status').textContent = '✅ Сигнал відправлено на ESP32. Закрийте вікно.';
    document.getElementById('weigh-send-status').style.color = '#68d391';
  }

  // ── Модал ────────────────────────────────────────────
  function closeModal(id, suppressOled = false) {
    document.getElementById(id).classList.remove('open');
    disableRegisterMode();
    stopCamera();
    if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
    fetch(API + '/weight/mode/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({active: false})
    });
    if (!suppressOled) {
      if (currentSession && currentSession.rfid) {
        sendOLED("Access Granted", toLatин(currentSession.name), "Use website");
      } else {
        sendOLED("Scan RFID", "to login");
      }
    }
  }

  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) {
        m.classList.remove('open');
        disableRegisterMode();
        stopCamera();
        if (weighPollInterval) { clearInterval(weighPollInterval); weighPollInterval = null; }
        fetch(API + '/weight/mode/', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({active: false})
        });
        if (currentSession && currentSession.rfid) {
          sendOLED("Access Granted", toLatин(currentSession.name), "Use website");
        } else {
          sendOLED("Scan RFID", "to login");
        }
      }
    });
  });

  // ── ESP32 статус ─────────────────────────────────────
  async function checkESP32Status() {
    const dot   = document.getElementById('esp32-dot');
    const label = document.getElementById('esp32-label');
    if (!dot || !label) return;
    try {
      const res = await fetch(API + '/weight/current/', { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      const w = parseFloat(data.weight);
      if (!isNaN(w)) {
        dot.className = 'esp32-dot online';
        label.textContent = 'ESP32 · онлайн';
      } else {
        dot.className = 'esp32-dot offline';
        label.textContent = 'ESP32 · офлайн';
      }
    } catch(e) {
      dot.className = 'esp32-dot offline';
      label.textContent = 'ESP32 · офлайн';
    }
  }
  checkESP32Status();
  setInterval(checkESP32Status, 5000);

  // ── Старт ────────────────────────────────────────────
  async function initApp() {
    await checkSession();
    refreshProtectedPage();
  }

  initApp();
