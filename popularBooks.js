// ======================================================
// DASHBOARD: FREQUENTLY BORROWED BOOKS
// ======================================================
// Used by both user/library.html and staff/library.html.
// Data comes from GET /api/stats/popular-books?days=...

(function () {
    const root = document.getElementById('popular-books-dashboard');
    if (!root) return;

    const periodSelect = root.querySelector('#dashboard-period');
    const tilesDiv = root.querySelector('#dashboard-tiles');
    const chartDiv = root.querySelector('#dashboard-chart');
    const roomDiv = root.querySelector('#dashboard-rooms');
    const tableBody = root.querySelector('#dashboard-table tbody');
    const tooltip = document.createElement('div');
    tooltip.className = 'dashboard-tooltip';
    tooltip.hidden = true;
    document.body.appendChild(tooltip);

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function formatDate(value) {
        if (!value) return 'Unknown';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Unknown';
        return date.toLocaleDateString(undefined, {
            day: 'numeric', month: 'short', year: 'numeric'
        });
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function tile(label, value, note) {
        return `
            <div class="dashboard-tile">
                <p class="dashboard-tile-label">${escapeHTML(label)}</p>
                <p class="dashboard-tile-value">${escapeHTML(value)}</p>
                ${note ? `<p class="dashboard-tile-note">${escapeHTML(note)}</p>` : ''}
            </div>`;
    }

    function showTooltip(event, html) {
        tooltip.innerHTML = html;
        tooltip.hidden = false;
        const x = Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
        const y = Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    }

    function hideTooltip() { tooltip.hidden = true; }

    function render(data) {
        const periodText = data.periodDays ? `in the last ${data.periodDays} days` : 'all time';

        tilesDiv.innerHTML =
            tile('Times borrowed', data.totalBorrows, periodText) +
            tile('Different books borrowed', data.distinctBooks, periodText) +
            tile('Out right now', data.currentlyBorrowed, 'currently borrowed') +
            tile('Overdue', data.overdue, 'past their return date');

        const books = data.topBooks || [];

        if (!books.length) {
            chartDiv.innerHTML = `<p class="library-empty-message">No books have been borrowed ${escapeHTML(periodText)} yet.</p>`;
            tableBody.innerHTML = '';
            roomDiv.textContent = '';
            return;
        }

        const max = Math.max(...books.map(book => book.borrowCount));

        chartDiv.innerHTML = books.map((book, index) => `
            <div class="dashboard-bar-row" data-index="${index}" tabindex="0">
                <span class="dashboard-bar-rank">${index + 1}</span>
                <span class="dashboard-bar-label">
                    <span class="dashboard-bar-title">${escapeHTML(book.title)}</span>
                    <span class="dashboard-bar-author">${escapeHTML(book.author)}</span>
                </span>
                <span class="dashboard-bar-track">
                    <span class="dashboard-bar-fill" style="width:${Math.max(2, (book.borrowCount / max) * 100)}%"></span>
                    <span class="dashboard-bar-value">${book.borrowCount}</span>
                </span>
            </div>`).join('');

        chartDiv.querySelectorAll('.dashboard-bar-row').forEach(row => {
            const book = books[Number(row.dataset.index)];
            const html = `
                <strong>${escapeHTML(book.title)}</strong><br>
                ${escapeHTML(book.author)}<br>
                Room: ${escapeHTML(book.status || 'Unknown')}<br>
                Borrowed ${escapeHTML(plural(book.borrowCount, 'time'))}<br>
                Last borrowed: ${escapeHTML(formatDate(book.lastBorrowedAt))}`;
            row.addEventListener('mousemove', event => showTooltip(event, html));
            row.addEventListener('mouseleave', hideTooltip);
            row.addEventListener('focus', () => {
                const box = row.getBoundingClientRect();
                showTooltip({ clientX: box.left + 40, clientY: box.bottom - 6 }, html);
            });
            row.addEventListener('blur', hideTooltip);
        });

        tableBody.innerHTML = books.map((book, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${escapeHTML(book.title)}</td>
                <td>${escapeHTML(book.author)}</td>
                <td>${escapeHTML(book.status || '')}</td>
                <td>${book.borrowCount}</td>
                <td>${escapeHTML(formatDate(book.lastBorrowedAt))}</td>
            </tr>`).join('');

        roomDiv.textContent = (data.byRoom || []).length
            ? 'By room: ' + data.byRoom.map(row => `${row.room} ${row.borrowCount}`).join(' · ')
            : '';
    }

    async function load() {
        try {
            const response = await fetch(`/api/stats/popular-books?days=${encodeURIComponent(periodSelect.value)}`);
            const text = await response.text();
            let data;
            try { data = text ? JSON.parse(text) : {}; }
            catch { throw new Error('The server returned an invalid response.'); }
            if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
            render(data);
        } catch (error) {
            tilesDiv.innerHTML = '';
            roomDiv.textContent = '';
            tableBody.innerHTML = '';
            chartDiv.innerHTML = `<p class="library-error-message">Could not load the dashboard: ${escapeHTML(error.message)}</p>`;
        }
    }

    periodSelect.addEventListener('change', load);

    // staffLibrary.js calls this after a borrow or return.
    window.refreshPopularBooks = load;

    load();
})();
