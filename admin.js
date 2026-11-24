
const accountDisplay = document.getElementById('account-display');
const searchInput = document.getElementById('admin-search-input');
const searchButton = document.getElementById('admin-search-submit');
const adminMessage = document.getElementById('admin-message');

let allAccounts = [];

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

async function readResponse(response) {
    const text = await response.text();

    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(
            'The server returned an invalid response. Check server.js.'
        );
    }

    if (!response.ok) {
        throw new Error(
            data.error || data.message || `Request failed (${response.status}).`
        );
    }

    return data;
}

function loginIsEnabled(value) {
    return value === 'True' || value === 'true';
}

function displayAccounts() {
    const search = searchInput.value.trim().toLowerCase();

    const filteredAccounts = allAccounts.filter(account =>
        String(account.username || '').toLowerCase().includes(search) ||
        String(account.status || '').toLowerCase().includes(search) ||
        String(account.enableLogin || '').toLowerCase().includes(search)
    );

    accountDisplay.innerHTML = '';

    if (filteredAccounts.length === 0) {
        accountDisplay.innerHTML = '<p>No accounts found.</p>';
        return;
    }

    filteredAccounts.forEach(account => {
        const enabled = loginIsEnabled(account.enableLogin);

        const card = document.createElement('article');
        card.className = 'account-card';

        card.innerHTML = `
            <p><strong>Username:</strong> ${escapeHTML(account.username)}</p>
            <p><strong>Status:</strong> ${escapeHTML(account.status)}</p>
            <p>
                <strong>Login:</strong>
                <span class="${enabled
                    ? 'account-status-enabled'
                    : 'account-status-disabled'}">
                    ${enabled ? 'Enabled' : 'Disabled'}
                </span>
            </p>
            <button
                type="button"
                class="${enabled ? 'disable-account' : 'enable-account'}"
            >
                ${enabled ? 'Disable' : 'Enable'}
            </button>
        `;

        const button = card.querySelector('button');

        button.addEventListener('click', () => {
            updateAccount(account, enabled ? 'disable' : 'enable', button);
        });

        accountDisplay.appendChild(card);
    });
}

async function loadAccounts() {
    accountDisplay.innerHTML = '<p>Loading accounts...</p>';
    adminMessage.textContent = '';

    try {
        const response = await fetch('/api/admin/accounts', {
            method: 'GET',
            cache: 'no-store'
        });

        allAccounts = await readResponse(response);
        displayAccounts();
    } catch (error) {
        accountDisplay.innerHTML = '';
        adminMessage.textContent = `Could not load accounts: ${error.message}`;
    }
}

async function updateAccount(account, action, button) {
    const actionText = action === 'enable' ? 'enable' : 'disable';

    if (!confirm(
        `Are you sure you want to ${actionText} login for "${account.username}"?`
    )) {
        return;
    }

    button.disabled = true;
    adminMessage.textContent = '';

    try {
        const response = await fetch(
            `/api/admin/accounts/${encodeURIComponent(account.username)}/${action}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const result = await readResponse(response);

        // Update local data using the server's confirmed response.
        const currentAccount = allAccounts.find(
            item => item.username === result.username
        );

        if (currentAccount) {
            currentAccount.enableLogin = result.enableLogin;
        }

        adminMessage.textContent = result.message;
        displayAccounts();
    } catch (error) {
        adminMessage.textContent =
            `Could not ${actionText} account: ${error.message}`;

        button.disabled = false;
    }
}

searchButton.addEventListener('click', displayAccounts);

searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        displayAccounts();
    }
});

loadAccounts();
