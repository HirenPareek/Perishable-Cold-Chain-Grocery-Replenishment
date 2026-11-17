/**
 * ColdChain Sync — Camunda 8 Live Bridge
 * Connects the Stitch UI to the real Camunda 8 Zeebe REST API
 * via the local server proxy at http://localhost:3000
 */
(function () {
  'use strict';

  const API = '';   // relative — same origin as the page (server.js on :3000)
  const POLL_INTERVAL = 8000; // ms between live refresh cycles

  // ─── Status Indicator ────────────────────────────────────────────────────────
  function createStatusBadge() {
    const badge = document.createElement('div');
    badge.id = 'camundaStatusBadge';
    badge.style.cssText = `
      position: fixed; bottom: 18px; right: 18px; z-index: 9999;
      display: flex; align-items: center; gap: 8px;
      background: #1e293b; color: #94a3b8;
      border: 1px solid #334155; border-radius: 999px;
      padding: 6px 14px; font-size: 11px; font-family: monospace;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      cursor: pointer; transition: all 0.2s;
    `;
    badge.innerHTML = `<span id="camundaDot" style="width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block"></span>
      <span id="camundaStatusText">Connecting to Camunda…</span>`;
    badge.title = 'Click to deploy BPMN & Forms to Camunda';
    badge.addEventListener('click', deployAndStart);
    document.body.appendChild(badge);
    return badge;
  }

  function setStatus(text, color) {
    const dot = document.getElementById('camundaDot');
    const label = document.getElementById('camundaStatusText');
    if (dot) dot.style.background = color;
    if (label) label.textContent = text;
  }

  // ─── Live Panel (floating) ────────────────────────────────────────────────
  function createLivePanel() {
    const panel = document.createElement('div');
    panel.id = 'camundaLivePanel';
    panel.style.cssText = `
      position: fixed; bottom: 60px; right: 18px; z-index: 9998; width: 320px;
      background: #0f172a; border: 1px solid #1e3a5f;
      border-radius: 12px; padding: 14px; display: none;
      font-family: monospace; font-size: 11px; color: #cbd5e1;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    `;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-weight:700;color:#38bdf8;font-size:12px;">⚡ Camunda 8 Live Connection</span>
        <button id="closeLivePanel" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div id="liveTopology" style="margin-bottom:8px;">
        <div style="color:#64748b;">Fetching topology…</div>
      </div>
      <hr style="border-color:#1e293b;margin:8px 0;">
      <div style="color:#94a3b8;margin-bottom:4px;font-weight:600;">Active Process Instances</div>
      <div id="liveInstances" style="max-height:120px;overflow-y:auto;">
        <div style="color:#64748b;">Loading…</div>
      </div>
      <hr style="border-color:#1e293b;margin:8px 0;">
      <div style="color:#94a3b8;margin-bottom:4px;font-weight:600;">Pending User Tasks</div>
      <div id="liveTasks" style="max-height:120px;overflow-y:auto;">
        <div style="color:#64748b;">Loading…</div>
      </div>
      <hr style="border-color:#1e293b;margin:8px 0;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button onclick="window.open('http://localhost:8080/operate','_blank')" style="flex:1;background:#0ea5e9;color:#fff;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:10px;">🔍 Operate</button>
        <button onclick="window.open('http://localhost:8080/tasklist','_blank')" style="flex:1;background:#8b5cf6;color:#fff;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:10px;">✅ Tasklist</button>
        <button id="btnDeployBpmn" onclick="deployAndStart()" style="flex:1;background:#10b981;color:#fff;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:10px;">🚀 Deploy</button>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('camundaStatusBadge').addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('closeLivePanel').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    return panel;
  }

  // ─── API calls ────────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    return r.json();
  }

  async function checkHealth() {
    try {
      const h = await apiFetch('/api/health');
      if (h.camunda === 'CONNECTED') {
        setStatus('Camunda 8 — LIVE ✓', '#10b981');
      } else {
        setStatus('Server OK · Camunda offline', '#f59e0b');
      }
      return h.camunda === 'CONNECTED';
    } catch {
      setStatus('Server offline', '#ef4444');
      return false;
    }
  }

  async function fetchTopology() {
    try {
      const t = await apiFetch('/camunda/v2/topology');
      const broker = t.brokers && t.brokers[0];
      const el = document.getElementById('liveTopology');
      if (!el) return;
      if (broker) {
        el.innerHTML = `
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#10b981;">● Broker Online</span>
            <span style="color:#64748b;">v${t.gatewayVersion || '8.10'}</span>
          </div>
          <div style="color:#64748b;margin-top:2px;">Partitions: ${broker.partitions ? broker.partitions.length : '—'} · Cluster: ${t.clusterSize || 1} node(s)</div>
        `;
      } else {
        el.innerHTML = `<div style="color:#f59e0b;">Camunda not reachable</div>`;
      }
    } catch (e) {
      const el = document.getElementById('liveTopology');
      if (el) el.innerHTML = `<div style="color:#ef4444;">Topology error</div>`;
    }
  }

  async function fetchInstances() {
    try {
      const data = await apiFetch('/api/instances');
      const el = document.getElementById('liveInstances');
      if (!el) return;
      const items = data.items || [];
      if (items.length === 0) {
        el.innerHTML = `<div style="color:#64748b;">No active instances — click Deploy to start one.</div>`;
        // Also update dashboard counter
        const kpiEl = document.querySelector('[data-kpi="active-batches"]');
        if (kpiEl) kpiEl.textContent = '0';
        return;
      }
      // Update dashboard KPI counter
      const kpiEl = document.querySelector('[data-kpi="active-batches"]');
      if (kpiEl) kpiEl.textContent = items.length;

      el.innerHTML = items.slice(0, 8).map(i => `
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1e293b;padding:3px 0;">
          <span style="color:#38bdf8;">${i.bpmnProcessId || 'coldChainReplenishment'}</span>
          <span style="color:#64748b;font-size:10px;">#${String(i.processInstanceKey).slice(-6)}</span>
        </div>
      `).join('');
    } catch {
      const el = document.getElementById('liveInstances');
      if (el) el.innerHTML = `<div style="color:#ef4444;">Error loading instances</div>`;
    }
  }

  async function fetchTasks() {
    try {
      const data = await apiFetch('/api/tasks');
      const el = document.getElementById('liveTasks');
      if (!el) return;
      const items = data.items || [];
      if (items.length === 0) {
        el.innerHTML = `<div style="color:#64748b;">No pending user tasks.</div>`;
        return;
      }
      el.innerHTML = items.slice(0, 6).map(t => `
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1e293b;padding:3px 0;align-items:center;">
          <div>
            <div style="color:#a78bfa;">${t.elementId || t.taskDefinitionId || 'User Task'}</div>
            <div style="color:#64748b;font-size:10px;">#${String(t.userTaskKey).slice(-6)}</div>
          </div>
          <button onclick="completeTask('${t.userTaskKey}')" 
            style="background:#10b981;color:#fff;border:none;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:10px;">
            ✓
          </button>
        </div>
      `).join('');

      // Update pending task count in dashboard if element exists
      const taskBadge = document.getElementById('pendingTaskCount');
      if (taskBadge) taskBadge.textContent = items.length;
    } catch {
      const el = document.getElementById('liveTasks');
      if (el) el.innerHTML = `<div style="color:#ef4444;">Error loading tasks</div>`;
    }
  }

  window.completeTask = async function (taskKey) {
    try {
      await apiFetch(`/api/tasks/${taskKey}/complete`, { method: 'POST', body: JSON.stringify({ variables: {} }) });
      showBridgeToast('Task Completed', `User Task #${String(taskKey).slice(-6)} completed in Camunda.`, '#10b981');
      await fetchTasks();
      await fetchInstances();
    } catch (e) {
      showBridgeToast('Error', 'Could not complete task: ' + e.message, '#ef4444');
    }
  };

  // ─── Deploy BPMN + Start Instance ────────────────────────────────────────
  window.deployAndStart = async function () {
    const btn = document.getElementById('btnDeployBpmn');
    if (btn) { btn.textContent = '⏳ Deploying…'; btn.disabled = true; }

    try {
      const deployRes = await apiFetch('/api/deploy', { method: 'POST' });
      if (deployRes.error) throw new Error(deployRes.error + ': ' + (deployRes.detail || ''));

      showBridgeToast('✅ Deployed', `BPMN & Forms deployed to Camunda 8.`, '#10b981');

      // Start a default process instance
      const startPayloadPath = '/camunda/v2/process-instances';
      const instanceRes = await apiFetch('/api/v1/process/start', {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'REQ-' + Math.floor(1000 + Math.random() * 9000),
          storeId: 'STORE-12',
          requestedBy: 'store.manager',
          budgetCap: 5000,
          maxTransitTempC: 8,
          items: [
            { sku: 'MILK-2L-ORG', description: '2L Organic Whole Milk', qty: 48, unitCostEstimate: 3.20 },
            { sku: 'YOG-500G-GRK', description: '500g Greek Yogurt', qty: 36, unitCostEstimate: 2.80 }
          ],
          suppliers: [
            { supplierId: 'SUP-GVD', name: 'Green Valley Dairy', contactEmail: 'orders@greenvalley.com' },
            { supplierId: 'SUP-HF', name: 'Hill Farms', contactEmail: 'supply@hillfarms.com' },
            { supplierId: 'SUP-SP', name: 'Sunny Pastures', contactEmail: 'rfq@sunnypastures.com' }
          ]
        })
      });
      if (instanceRes.processInstanceKey || instanceRes.key) {
        const key = instanceRes.processInstanceKey || instanceRes.key;
        showBridgeToast('🚀 Instance Started', `Process #${String(key).slice(-6)} running in Camunda.`, '#0ea5e9');
        await fetchInstances();
        await fetchTasks();
      }
    } catch (e) {
      showBridgeToast('Deploy Error', e.message, '#ef4444');
    } finally {
      if (btn) { btn.textContent = '🚀 Deploy'; btn.disabled = false; }
    }
  };

  // ─── Toast Notification ───────────────────────────────────────────────────
  function showBridgeToast(title, message, color) {
    // Try to use the page's existing showToast if available
    if (typeof window.showToast === 'function') {
      window.showToast(title, message, color === '#10b981' ? 'success' : color === '#ef4444' ? 'error' : 'info');
      return;
    }
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;top:20px;right:20px;z-index:99999;
      background:${color};color:#fff;border-radius:8px;
      padding:10px 16px;font-size:12px;font-family:monospace;
      box-shadow:0 4px 16px rgba(0,0,0,0.4);max-width:280px;
    `;
    toast.innerHTML = `<b>${title}</b><br>${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ─── Wire up "New Replenishment" button to deploy+start ──────────────────
  function wireReplenishmentButton() {
    const btn = document.getElementById('btnNewReplenishment');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      // Allow modal to open (original handler), then also trigger real Camunda start
      await new Promise(r => setTimeout(r, 1200));
      const modalForm = document.getElementById('modalNewReplenishment');
      if (modalForm && !modalForm.classList.contains('hidden')) return; // modal opened, let user fill it
      // If no modal, just start directly
      deployAndStart();
    });

    // Also wire the modal submit button if it exists
    const submitBtn = document.getElementById('btnSubmitNewReplenishment') || document.querySelector('#modalNewReplenishment button[type="submit"]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => setTimeout(deployAndStart, 300));
    }
  }

  // ─── Inject Camunda links into the nav if Operate/Tasklist not linked ────
  function injectCamundaNavLinks() {
    const nav = document.querySelector('nav') || document.querySelector('header');
    if (!nav || document.getElementById('camundaNavLinks')) return;
    const links = document.createElement('div');
    links.id = 'camundaNavLinks';
    links.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 8px;';
    links.innerHTML = `
      <a href="http://localhost:8080/operate" target="_blank" title="Camunda Operate"
        style="font-size:10px;padding:3px 8px;background:#0ea5e910;border:1px solid #0ea5e940;border-radius:5px;color:#38bdf8;text-decoration:none;font-family:monospace;">
        ⬡ Operate
      </a>
      <a href="http://localhost:8080/tasklist" target="_blank" title="Camunda Tasklist"
        style="font-size:10px;padding:3px 8px;background:#8b5cf610;border:1px solid #8b5cf640;border-radius:5px;color:#a78bfa;text-decoration:none;font-family:monospace;">
        ✅ Tasklist
      </a>
    `;
    nav.appendChild(links);
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  async function init() {
    createStatusBadge();
    createLivePanel();
    wireReplenishmentButton();
    injectCamundaNavLinks();

    const online = await checkHealth();
    if (online) {
      await Promise.all([fetchTopology(), fetchInstances(), fetchTasks()]);
      setInterval(async () => {
        await checkHealth();
        await Promise.all([fetchTopology(), fetchInstances(), fetchTasks()]);
      }, POLL_INTERVAL);
    } else {
      setStatus('Camunda offline — using mock data', '#f59e0b');
      setInterval(checkHealth, 10000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
