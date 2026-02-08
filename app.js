// ===== Money helpers =====

function dollarsToCents(d) {
  return Math.round(Number(d || 0) * 100);
}

const dollarFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function centsToDollars(cents) {
  return dollarFormatter.format(cents / 100);
}

// ===== Data model =====

const STORAGE_KEY = 'deadSimpleBudgetState_v1';

class Envelope {
  constructor(id, name, targetCents, balanceCents, flags = {}) {
    this.id = id;
    this.name = name;
    this.targetCents = targetCents;   // budget per period, in cents
    this.balanceCents = balanceCents; // current balance, in cents
    this.isIncome = !!flags.isIncome;
    this.isOverflow = !!flags.isOverflow;
    this.isCreditCard = !!flags.isCreditCard;
    this.isActive = flags.isActive !== false;
  }
}

class Transaction {
  constructor({ id, timestamp, fromEnvelopeId, toEnvelopeId, amountCents, note }) {
    this.id = id;
    this.timestamp = timestamp;
    this.fromEnvelopeId = fromEnvelopeId || null;
    this.toEnvelopeId = toEnvelopeId || null;
    this.amountCents = amountCents;
    this.note = note || '';
  }
}

class State {
  constructor() {
    this.envelopes = [];
    this.transactions = [];
    this.bankBalanceCents = 0;
    this.settings = {
      transactionRetentionDays: 30,
    };
  }
}

let state = new State();

// ===== Persistence =====

function saveState() {
  try {
    const json = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, json);
    console.log('State saved:', state);
  } catch (err) {
    console.error('Failed to save state', err);
  }
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    state = new State();
    console.log('No saved state, using fresh State');
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const newState = new State();

    newState.bankBalanceCents = parsed.bankBalanceCents || 0;
    newState.settings = parsed.settings || newState.settings;

    newState.envelopes = (parsed.envelopes || []).map(e =>
      new Envelope(
        e.id,
        e.name,
        e.targetCents,
        e.balanceCents,
        {
          isIncome: e.isIncome,
          isOverflow: e.isOverflow,
          isCreditCard: e.isCreditCard,
          isActive: e.isActive,
        }
      )
    );

    newState.transactions = (parsed.transactions || []).map(t =>
      new Transaction(t)
    );

    state = newState;
    console.log('State loaded:', state);
  } catch (err) {
    console.error('Failed to load state, resetting', err);
    state = new State();
  }
}

function exportStateToFile() {
  // Make sure the latest state is saved
  saveState();

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    alert('No data to export.');
    return;
  }

  const blob = new Blob([raw], { type: 'application/json' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `budget-backup-${timestamp}.json`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importStateFromFile(file) {
  if (!file) {
    alert('Choose a file first.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const text = event.target.result;
      const parsed = JSON.parse(text);

      // Minimal shape check
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid JSON structure.');
      }
      if (!Array.isArray(parsed.envelopes) || !Array.isArray(parsed.transactions)) {
        throw new Error('Missing envelopes/transactions arrays.');
      }

      const ok = confirm(
        'Importing this backup will overwrite your current budget data.\n\n' +
        'Continue?'
      );
      if (!ok) return;

      // Write raw JSON back into localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));

      // Reload app to re-run loadState/ensureCoreEnvelopes/etc.
      location.reload();
    } catch (err) {
      console.error('Failed to import backup:', err);
      alert('Failed to import backup: ' + err.message);
    }
  };
  reader.onerror = (err) => {
    console.error('File read error:', err);
    alert('Error reading file.');
  };

  reader.readAsText(file);
}

// ===== Bank Operations ====
function updateBankBalance(dollars) {
  state.bankBalanceCents = dollarsToCents(dollars);
  saveState();
  renderSummary();
}

// ===== Envelope operations =====
function ensureCoreEnvelopes() {
  // Fix duplicates if they ever exist
  const incomeEnvs = state.envelopes.filter(e => e.isIncome);
  const overflowEnvs = state.envelopes.filter(e => e.isOverflow);

  if (incomeEnvs.length > 1) {
    incomeEnvs.slice(1).forEach(e => { e.isIncome = false; });
  }
  if (overflowEnvs.length > 1) {
    overflowEnvs.slice(1).forEach(e => { e.isOverflow = false; });
  }

  // Ensure exactly one Income
  let income = state.envelopes.find(e => e.isIncome);
  if (!income) {
    income = new Envelope(
      'env_income',
      'Income',
      0,  // no target
      0,
      { isIncome: true, isOverflow: false, isCreditCard: false, isActive: true }
    );
    state.envelopes.push(income);
  } else {
    income.targetCents = 0;
    income.isActive = true;
  }

  // Ensure exactly one Overflow
  let overflow = state.envelopes.find(e => e.isOverflow);
  if (!overflow) {
    overflow = new Envelope(
      'env_overflow',
      'Overflow',
      0,
      0,
      { isIncome: false, isOverflow: true, isCreditCard: false, isActive: true }
    );
    state.envelopes.push(overflow);
  } else {
    overflow.targetCents = 0;
    overflow.isActive = true;
  }

  saveState();
}

function renderCoreEnvelopesPanel() {
  const income = getIncomeEnvelope();
  const overflow = getOverflowEnvelope();

  const incomeEl = document.getElementById('income-balance');
  const overflowEl = document.getElementById('overflow-balance');

  if (incomeEl) incomeEl.textContent = income ? centsToDollars(income.balanceCents) : '0.00';
  if (overflowEl) overflowEl.textContent = overflow ? centsToDollars(overflow.balanceCents) : '0.00';
}

function isCoreEnvelope(env) {
  return env.isIncome || env.isOverflow;
}

function getIncomeEnvelope() {
  return state.envelopes.find(e => e.isIncome);
}

function getOverflowEnvelope() {
  return state.envelopes.find(e => e.isOverflow);
}

function addEnvelope(name, targetDollars, flags = {}) {
  if (!name) return;
  const id = 'env_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  const targetCents = dollarsToCents(targetDollars);
  const env = new Envelope(id, name, targetCents, 0, flags);
  state.envelopes.push(env);
  console.log('Envelope added:', env);
  saveState();
  renderEnvelopes();
}

function addCreditCardEnvelope(name) {
  const cardName = name || prompt('Credit card name (e.g. "Visa", "Amex")');
  if (!cardName) return;

  const id = 'card_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  const env = new Envelope(id, cardName, 0, 0, {
    isIncome: false,
    isOverflow: false,
    isCreditCard: true,
    isActive: true,
  });

  state.envelopes.push(env);
  saveState();
  renderEnvelopes();
  renderCreditCards();
  renderTransactionEnvelopeOptions();
}

function deleteEnvelope(id) {
  const env = state.envelopes.find(e => e.id === id);
  if (!env) return;

  if (isCoreEnvelope(env)) {
    alert('Income and Overflow envelopes cannot be deleted.');
    return;
  }

  const income = getIncomeEnvelope();
  if (!income) {
    alert('Income envelope not found; cannot safely delete.');
    return;
  }

  if (env.balanceCents !== 0) {
    const amountDollars = env.balanceCents / 100;
    const ok = confirm(
      `This envelope has a balance of $${amountDollars.toFixed(2)}.\n` +
      `If you delete it, that balance will be moved back to Income.\n\n` +
      `Continue?`
    );
    if (!ok) return;

    // Move full balance back to Income as a transaction
    addTransaction({
      fromEnvelopeId: env.id,
      toEnvelopeId: income.id,
      amountDollars,
      note: `Auto-merge from deleted envelope "${env.name}"`,
    });

    // After addTransaction, env.balanceCents should be zero
  }

  // Soft delete: mark inactive
  env.isActive = false;

  saveState();
  renderEnvelopes();
  renderTransactions();
}

function updateEnvelope(id, updates) {
  const env = state.envelopes.find(e => e.id === id);
  if (!env) return;

  const core = isCoreEnvelope(env);

  if (!core) {
    if (updates.name != null) env.name = updates.name;
    if (updates.targetDollars != null) {
      env.targetCents = dollarsToCents(updates.targetDollars);
    }
  }

  if (updates.isIncome != null) env.isIncome = !!updates.isIncome;
  if (updates.isOverflow != null) env.isOverflow = !!updates.isOverflow;
  if (updates.isCreditCard != null) env.isCreditCard = !!updates.isCreditCard;
  if (updates.isActive != null && !core) env.isActive = !!updates.isActive; // never deactivate core

  saveState();
  renderEnvelopes();
}

function getTotalEnvelopesBalanceCents() {
  return state.envelopes
    .filter(e => e.isActive)
    .reduce((sum, e) => sum + e.balanceCents, 0);
}

function getTotalNonCardEnvelopesBalanceCents() {
  return state.envelopes
    .filter(e => e.isActive && !e.isCreditCard)
    .reduce((sum, e) => sum + e.balanceCents, 0);
}

function getTotalCreditCardBalanceCents() {
  return state.envelopes
    .filter(e => e.isActive && e.isCreditCard)
    .reduce((sum, e) => sum + e.balanceCents, 0);
}

function getTotalAllocationsCents() {
  return state.envelopes
    .filter(env =>
      !env.isCore &&           // exclude Income & Overflow
      !env.isCredit &&         // exclude credit cards
      env.targetCents > 0           // only things the user allocates into
    )
    .reduce((sum, env) => sum + env.targetCents, 0);
}

function cleanupUnusedEnvelopes() {
  // Build set of all envelope IDs that are still referenced in transactions
  const usedIds = new Set();
  for (const tx of state.transactions) {
    if (tx.fromEnvelopeId) usedIds.add(tx.fromEnvelopeId);
    if (tx.toEnvelopeId) usedIds.add(tx.toEnvelopeId);
  }

  state.envelopes = state.envelopes.filter(env => {
    // Never remove core envelopes
    if (isCoreEnvelope(env)) return true;

    // Keep active envelopes
    if (env.isActive) return true;

    // For inactive envelopes:
    // - if they are used in any remaining transaction, keep them (for history names)
    // - if they have non-zero balance (should not happen, but be safe), keep them
    if (env.balanceCents !== 0) return true;
    if (usedIds.has(env.id)) return true;

    // Inactive, zero balance, and no references -> safe to permanently remove
    return false;
  });

  saveState();
}

// ===== Transactions operations ====
function addTransaction({ fromEnvelopeId, toEnvelopeId, amountDollars, note, log = true }) {
  const amountCents = dollarsToCents(amountDollars);
  if (!amountCents) return;

  const tx = new Transaction({
    id: crypto.randomUUID ? crypto.randomUUID() : 'tx_' + Date.now(),
    timestamp: new Date().toISOString(),
    fromEnvelopeId: fromEnvelopeId || null,
    toEnvelopeId: toEnvelopeId || null,
    amountCents,
    note: note || '',
  });

  applyTransactionToBalances(tx, +1);

  if (log) {
    state.transactions.push(tx);
  }

  saveState();
  renderEnvelopes();

  if (log) {
    renderTransactions();
  }
}

function applyTransactionToBalances(tx, direction) {
  const sign = direction; // +1 apply, -1 rollback

  if (tx.fromEnvelopeId) {
    const from = state.envelopes.find(e => e.id === tx.fromEnvelopeId);
    if (from) {
      from.balanceCents -= sign * tx.amountCents;
    }
  }

  if (tx.toEnvelopeId) {
    const to = state.envelopes.find(e => e.id === tx.toEnvelopeId);
    if (to) {
      to.balanceCents += sign * tx.amountCents;
    }
  }
}

function updateTransaction(id, updates) {
  const index = state.transactions.findIndex(t => t.id === id);
  if (index === -1) return;

  const oldTx = state.transactions[index];

  // 1) rollback old
  applyTransactionToBalances(oldTx, -1);

  // 2) build updated transaction
  const newTx = new Transaction({
    id: oldTx.id,
    timestamp: oldTx.timestamp, // keep original timestamp
    fromEnvelopeId: updates.fromEnvelopeId !== undefined ? updates.fromEnvelopeId : oldTx.fromEnvelopeId,
    toEnvelopeId: updates.toEnvelopeId !== undefined ? updates.toEnvelopeId : oldTx.toEnvelopeId,
    amountCents: updates.amountDollars !== undefined
      ? dollarsToCents(updates.amountDollars)
      : oldTx.amountCents,
    note: updates.note !== undefined ? updates.note : oldTx.note,
  });

  // 3) apply new
  applyTransactionToBalances(newTx, +1);

  // 4) store and re-render
  state.transactions[index] = newTx;
  saveState();
  renderEnvelopes();
  renderTransactions();
}

function deleteTransaction(id) {
  const index = state.transactions.findIndex(t => t.id === id);
  if (index === -1) return;

  const tx = state.transactions[index];

  // Reactivate any inactive envelopes referenced by this transaction.
  // This fixes the case where a deleted envelope was auto-merged into Income,
  // and then the user deletes the auto-merge transaction:
  // the original envelope becomes active again with its balance restored.
  [tx.fromEnvelopeId, tx.toEnvelopeId].forEach(envId => {
    if (!envId) return;
    const env = state.envelopes.find(e => e.id === envId);
    if (env && !env.isActive) {
      env.isActive = true;
    }
  });

  // Roll back balances
  applyTransactionToBalances(tx, -1);

  // Remove transaction
  state.transactions.splice(index, 1);

  saveState();
  renderEnvelopes();
  renderTransactions();
}


function pruneOldTransactions() {
  const days = state.settings?.transactionRetentionDays || 45; // you can set to 30 if you prefer
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffISO = cutoff.toISOString();

  const beforeCount = state.transactions.length;

  state.transactions = state.transactions.filter(tx => {
    // ISO 8601 strings compare lexicographically by time, so this works
    return tx.timestamp >= cutoffISO;
  });

  if (state.transactions.length !== beforeCount) {
    console.log(
      `Pruned transactions: ${beforeCount - state.transactions.length} old entries removed`
    );
    saveState();
  }
}

function addIncome(amountDollars, note) {
  const incomeEnv = getIncomeEnvelope();
  if (!incomeEnv) {
    alert('Income envelope not found.');
    return;
  }
  addTransaction({
    fromEnvelopeId: null,
    toEnvelopeId: incomeEnv.id,
    amountDollars,
    note: note || 'Income',
  });
}

function autoAllocate() {
  const income = getIncomeEnvelope();
  if (!income) {
    alert('Income envelope not found.');
    return;
  }

  // Select target envelopes:
  // - active
  // - not core (so excludes Income/Overflow)
  // - not credit cards
  // - target > 0
  const targets = state.envelopes.filter(env =>
    env.isActive &&
    !isCoreEnvelope(env) &&
    !env.isCreditCard &&
    env.targetCents > 0
  );

  if (targets.length === 0) {
    alert('No envelopes with a positive target to allocate to.');
    return;
  }

  const totalToAllocateCents = targets.reduce(
    (sum, env) => sum + env.targetCents,
    0
  );

  const ok = confirm(
    `This will move $${centsToDollars(totalToAllocateCents)} ` +
    `from Income to your target envelopes.\n\n` +
    `Income may go below zero. Continue?`
  );
  if (!ok) return;

  // Perform internal transfers using the transaction engine, but do not log them
  targets.forEach(env => {
    const amountDollars = env.targetCents / 100;
    addTransaction({
      fromEnvelopeId: income.id,
      toEnvelopeId: env.id,
      amountDollars,
      note: 'Auto allocation',
      log: false
    });
  });

  // Envelopes already re-rendered by addTransaction; just refresh summary explicitly
  renderSummary();
}

// ===== Rendering =====

function renderSummary() {
  const totalEnvCents = getTotalEnvelopesBalanceCents();
  const cardCents = getTotalCreditCardBalanceCents();
  const bankCents = state.bankBalanceCents || 0;
  const netAfterCardsCents = totalEnvCents - cardCents;
  const diffCents = bankCents - totalEnvCents;
  const allocCents = getTotalAllocationsCents();

  const elEnv = document.getElementById('sum-envelopes');
  const elCards = document.getElementById('sum-cards');
  const elBank = document.getElementById('sum-bank');
  const elNet = document.getElementById('sum-net-after-cards');
  const elDiff = document.getElementById('sum-diff');
  const elAlloc = document.getElementById('sum-allocations');
 
  if (elEnv) elEnv.textContent = centsToDollars(totalEnvCents);
  if (elCards) elCards.textContent = centsToDollars(cardCents);
  if (elBank) elBank.textContent = centsToDollars(bankCents);
  if (elNet) elNet.textContent = centsToDollars(netAfterCardsCents);
  if (elDiff) elDiff.textContent = centsToDollars(diffCents);
  if (elAlloc) elAlloc.textContent = centsToDollars(allocCents);
}

function renderEnvelopes() {
  const container = document.getElementById('envelopes-list');
  if (!container) return;

  container.innerHTML = '';

  state.envelopes
    .filter(e => e.isActive && !e.isCreditCard && !isCoreEnvelope(e))
    .forEach(env => {
      const row = document.createElement('div');
      row.className = 'envelope';

      const info = document.createElement('div');
      info.className = 'envelope-info';

      const labels = [];
      if (env.isIncome) labels.push('[Income]');
      if (env.isOverflow) labels.push('[Overflow]');
      if (env.isCreditCard) labels.push('[Card]');
      const labelStr = labels.length ? ' ' + labels.join(' ') : '';

      // Target display: hide/replace for core envelopes
      const targetDisplay = isCoreEnvelope(env)
        ? ''
        : ` ($${centsToDollars(env.targetCents)})`;

      info.innerHTML = `
        <strong>${env.name}</strong>
        <span>$${centsToDollars(env.balanceCents)}</span>
        <span>${targetDisplay}</span>
      `;

      const actions = document.createElement('div');

      // Only allow editing/deleting for non-core envelopes
      if (!isCoreEnvelope(env)) {
        // Edit button
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => {
          const newName = prompt('Envelope name', env.name);
          if (!newName) return;
          const newTargetStr = prompt(
            'Target per period (dollars)',
            (env.targetCents / 100).toString()
          );
          const newTarget = Number(newTargetStr) || 0;
          updateEnvelope(env.id, { name: newName, targetDollars: newTarget });
          renderTransactions();
        });
        actions.appendChild(editBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          if (!confirm(`Delete envelope "${env.name}"?`)) return;
          deleteEnvelope(env.id);
        });
        actions.appendChild(deleteBtn);
      }

      row.appendChild(info);
      row.appendChild(actions);

      container.appendChild(row);
    });

  renderTransactionEnvelopeOptions();
  renderCreditCards();
  renderSummary();
  renderCoreEnvelopesPanel();
}

function renderCreditCards() {
  const container = document.getElementById('cards-list');
  if (!container) return;

  container.innerHTML = '';

  state.envelopes
    .filter(e => e.isActive && e.isCreditCard)
    .forEach(env => {
      const row = document.createElement('div');
      row.className = 'card';

      const info = document.createElement('div');
      info.className = 'card-info';

      // Card "target" is always conceptually N/A
      const balanceStr = centsToDollars(env.balanceCents);

      info.innerHTML = `
        <strong>${env.name}</strong>
        <span>$${balanceStr}</span>
      `;

      const actions = document.createElement('div');
      actions.style.display = 'inline-flex';
      actions.style.gap = '0.25rem';
      actions.style.marginLeft = '0.1rem';

      // For cards, allow rename but not target editing
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Rename';
      editBtn.addEventListener('click', () => {
        const newName = prompt('Card name', env.name);
        if (!newName) return;
        updateEnvelope(env.id, { name: newName });
        renderTransactions
      });
      actions.appendChild(editBtn);

      // Deletion rule for cards: require zero balance (pay off first)
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        if (env.balanceCents !== 0) {
          alert('You must pay this card to $0 before deleting it.');
          return;
        }
        if (!confirm(`Delete credit card "${env.name}"?`)) return;
        // Reuse deleteEnvelope, but since balance is zero, nothing will be merged
        deleteEnvelope(env.id);
      });
      actions.appendChild(deleteBtn);

      row.appendChild(info);
      row.appendChild(actions);

      container.appendChild(row);
    });
}

function renderTransactions() {
  const container = document.getElementById('transactions-list');
  if (!container) return;

  container.innerHTML = '';

  const txs = [...state.transactions].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );

  txs.forEach(tx => {
    const row = document.createElement('div');
    row.className = 'transaction';

    const dateStr = new Date(tx.timestamp).toLocaleDateString();

    const fromName = tx.fromEnvelopeId
      ? (state.envelopes.find(e => e.id === tx.fromEnvelopeId)?.name || '(unknown)')
      : 'Add to';

    const toName = tx.toEnvelopeId
      ? (state.envelopes.find(e => e.id === tx.toEnvelopeId)?.name || '(unknown)')
      : 'Spent';

    const textSpan = document.createElement('span');
    textSpan.textContent =
      `${dateStr} | $${centsToDollars(tx.amountCents)}  | ${fromName} → ${toName} | ${tx.note}`;

    const buttonsDiv = document.createElement('div');
    buttonsDiv.style.display = 'inline-flex';
    buttonsDiv.style.gap = '0.25rem';
    buttonsDiv.style.marginLeft = '0.1rem';


    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      // simple prompt-based editor for now
      const amountDollars = Number(prompt(
        'New amount (dollars):',
        (tx.amountCents / 100).toString()
      ));
      if (!amountDollars || amountDollars <= 0) return;

      const note = prompt('Note:', tx.note ?? '') ?? tx.note;

      updateTransaction(tx.id, {
        amountDollars,
        note,
      });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!confirm('Delete this transaction?')) return;
      deleteTransaction(tx.id);
    });

    buttonsDiv.appendChild(editBtn);
    buttonsDiv.appendChild(deleteBtn);

    row.appendChild(buttonsDiv);
    row.appendChild(textSpan);

    container.appendChild(row);
  });
}

function renderTransactionEnvelopeOptions() {
  const fromSelect = document.getElementById('tx-from');
  const toSelect = document.getElementById('tx-to');
  if (!fromSelect || !toSelect) return;

  // Preserve the "(none)" option at the top
  const baseOptionFrom = '<option value="">(none)</option>';
  const baseOptionTo = '<option value="">(none)</option>';

  fromSelect.innerHTML = baseOptionFrom;
  toSelect.innerHTML = baseOptionTo;

  state.envelopes
    .filter(e => e.isActive)
    .forEach(env => {
      const optFrom = document.createElement('option');
      optFrom.value = env.id;
      optFrom.textContent = env.name + " $" + centsToDollars(env.balanceCents);
      fromSelect.appendChild(optFrom);

      const optTo = document.createElement('option');
      optTo.value = env.id;
      optTo.textContent = env.name + " $" + centsToDollars(env.balanceCents);
      toSelect.appendChild(optTo);
    });
}

// ===== Init and wiring =====

function init() {
  console.log('App initialized');

  loadState();
  ensureCoreEnvelopes();
  pruneOldTransactions();
  cleanupUnusedEnvelopes();

  // Backup & restore
    const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const importFileInput = document.getElementById('import-file');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportStateToFile();
    });
  }

  if (importBtn && importFileInput) {
    // Clicking "Import" opens the system file picker
    importBtn.addEventListener('click', () => {
      importFileInput.value = '';  // reset so selecting same file again works
      importFileInput.click();
    });

    // When a file is chosen, perform the import
    importFileInput.addEventListener('change', () => {
      const file = importFileInput.files[0];
      if (file) {
        importStateFromFile(file);
      }
    });
  }


  // Bank & summary
  const bankInput = document.getElementById('bank-input');
  const bankSaveBtn = document.getElementById('bank-save-btn');

  if (bankSaveBtn && bankInput) {
    bankSaveBtn.addEventListener('click', () => {
      const value = Number(bankInput.value);
      if (Number.isNaN(value)) {
        alert('Enter a valid bank balance.');
        return;
      }
      bankInput.value = '';
      updateBankBalance(value);
    });
  }

  const addEnvBtn = document.getElementById('add-envelope-btn');
  if (addEnvBtn) {
    addEnvBtn.addEventListener('click', () => {
      const name = prompt('Envelope name');
      if (!name) return;
      const targetStr = prompt('How much to put aside each pay period (dollars)');
      const target = Number(targetStr) || 0;
      addEnvelope(name, target);
    });
  }

  const addCardBtn = document.getElementById('add-card-btn');
  if (addCardBtn) {
    addCardBtn.addEventListener('click', () => {
      addCreditCardEnvelope();
    });
  }

  // Income wiring
  const incomeInput = document.getElementById('income-input');
  const incomeBtn = document.getElementById('income-btn');

  if (incomeBtn && incomeInput) {
    incomeBtn.addEventListener('click', () => {
      const amount = Number(incomeInput.value);
      if (!amount || amount <= 0) {
        alert('Enter a positive income amount.');
        return;
      }
      addIncome(amount, "New Income");
      incomeInput.value = '';
      renderSummary();
    });
  }

  // Auto allocate wiring
  const autoAllocateBtn = document.getElementById('auto-allocate-btn');
  if (autoAllocateBtn) {
    autoAllocateBtn.addEventListener('click', () => {
      autoAllocate();
    });
  }

  // Transaction form wiring
  const txFrom = document.getElementById('tx-from');
  const txTo = document.getElementById('tx-to');
  const txAmount = document.getElementById('tx-amount');
  const txNote = document.getElementById('tx-note');
  const txAddBtn = document.getElementById('tx-add-btn');

  if (txAddBtn && txFrom && txTo && txAmount && txNote) {
    txAddBtn.addEventListener('click', () => {
      const fromId = txFrom.value || null;
      const toId = txTo.value || null;
      const amount = Number(txAmount.value);
      const note = txNote.value;

      if (!fromId && !toId) {
        alert('Select at least one envelope (from or to).');
        return;
      }
      if (!amount || amount <= 0) {
        alert('Enter a positive amount.');
        return;
      }

      addTransaction({
        fromEnvelopeId: fromId,
        toEnvelopeId: toId,
        amountDollars: amount,
        note,
      });

      txAmount.value = '';
      txNote.value = '';
    });
  }
  renderEnvelopes();
  renderTransactions();
  renderCreditCards();
  renderSummary();
  renderCoreEnvelopesPanel();
}


document.addEventListener('DOMContentLoaded', init);
