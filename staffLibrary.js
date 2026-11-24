const patternSearchInput = document.getElementById('pattern-search-input');
const patternSearchSubmit = document.getElementById('pattern-search-submit');
const bookDisplay = document.getElementById('book-display');
const borrowedBookDiv = document.getElementById('borrowed-book-div');
const donateBookDiv = document.getElementById('donate-book-div');
const confirmationDialog = document.getElementById('confirmation-dialog');
const confirmationMessage = document.getElementById('confirmation-message');
const borrowDialog = document.getElementById('borrow-dialog');
const donationDialog = document.getElementById('donation-dialog');
let selectedBookForDelete = null;
let selectedBookForBorrow = null;
let selectedDonation = null;

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}
async function readResponse(response) {
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error('The server returned an invalid response. Check server.js.'); }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
    return data;
}
function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
}
function isOverdue(value) {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}
function refreshDashboard() {
    if (typeof window.refreshPopularBooks === 'function') window.refreshPopularBooks();
}
function showDialog(dialog) { dialog.hidden = false; dialog.style.display = 'flex'; }
function hideDialog(dialog) { dialog.hidden = true; dialog.style.display = 'none'; }

async function findBooks() {
    try {
        const response = await fetch(`/api/books?search=${encodeURIComponent(patternSearchInput.value.trim())}`);
        const books = await readResponse(response);
        bookDisplay.innerHTML = '';
        if (!books.length) { bookDisplay.innerHTML = '<p class="library-empty-message">No books found.</p>'; return; }
        books.forEach(book => {
            const card = document.createElement('aside');
            card.className = 'book-card';
            if (book.borrowed) {
                // Borrowed books are shown but cannot be deleted or borrowed
                // again until they are returned.
                card.classList.add('book-card-borrowed');
                card.innerHTML = `
                    <p><strong>Title:</strong> ${escapeHTML(book.title)}</p>
                    <p><strong>Author:</strong> ${escapeHTML(book.author)}</p>
                    <p><strong>Status/Room:</strong> ${escapeHTML(book.status)}</p>
                    <p class="borrowed-status"><strong>Status:</strong> borrowed</p>
                    <p><strong>Return date:</strong> ${escapeHTML(formatDate(book.dueAt))}${isOverdue(book.dueAt) ? ' <span class="overdue-tag">OVERDUE</span>' : ''}</p>
                    <p><strong>Description:</strong> ${escapeHTML(book.bookDescription || 'No description')}</p>`;
                bookDisplay.appendChild(card);
                return;
            }
            card.innerHTML = `
                <p><strong>Title:</strong> ${escapeHTML(book.title)}</p>
                <p><strong>Author:</strong> ${escapeHTML(book.author)}</p>
                <p><strong>Status/Room:</strong> ${escapeHTML(book.status)}</p>
                <p><strong>Description:</strong> ${escapeHTML(book.bookDescription || 'No description')}</p>
                <div class="book-card-actions">
                    <button type="button" class="delete-book-btn">DELETE</button>
                    <button type="button" class="borrow-book-btn">BORROW</button>
                </div>`;
            card.querySelector('.delete-book-btn').addEventListener('click', () => {
                selectedBookForDelete = book;
                confirmationMessage.textContent = `Are you sure you want to delete “${book.title}” by ${book.author}?`;
                showDialog(confirmationDialog);
            });
            card.querySelector('.borrow-book-btn').addEventListener('click', () => {
                selectedBookForBorrow = book;
                document.getElementById('borrow-username').value = '';
                showDialog(borrowDialog);
            });
            bookDisplay.appendChild(card);
        });
    } catch (error) { bookDisplay.innerHTML = `<p class="library-error-message">${escapeHTML(error.message)}</p>`; }
}

async function addBook() {
    const book = {
        title: document.getElementById('bookTitle').value.trim(),
        author: document.getElementById('bookAuthor').value.trim(),
        status: document.getElementById('bookStatus').value.trim(),
        bookDescription: document.getElementById('bookDescription').value.trim()
    };
    if (Object.values(book).some(value => !value)) { alert('Please fill in all book fields.'); return; }
    try {
        const response = await fetch('/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(book) });
        const result = await readResponse(response);
        alert(result.message || 'Book added.');
        ['bookTitle', 'bookAuthor', 'bookStatus', 'bookDescription'].forEach(id => document.getElementById(id).value = '');
        await findBooks();
    } catch (error) { alert(`Could not add book: ${error.message}`); }
}

async function deleteSelectedBook() {
    if (!selectedBookForDelete) return;
    try {
        const response = await fetch('/api/books', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selectedBookForDelete) });
        const result = await readResponse(response);
        hideDialog(confirmationDialog);
        selectedBookForDelete = null;
        await findBooks();
        alert(result.message || 'Book deleted.');
    } catch (error) { alert(`Could not delete book: ${error.message}`); }
}
async function borrowSelectedBook() {
    const username = document.getElementById('borrow-username').value.trim();
    if (!selectedBookForBorrow || !username) { alert('Enter the student username or email.'); return; }
    try {
        const response = await fetch('/api/borrow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book: selectedBookForBorrow, username }) });
        const result = await readResponse(response);
        hideDialog(borrowDialog);
        selectedBookForBorrow = null;
        await Promise.all([findBooks(), displayBorrowedBooks()]);
        refreshDashboard();
        alert(result.message || 'Book borrowed.');
    } catch (error) { alert(`Could not borrow book: ${error.message}`); }
}
async function displayBorrowedBooks() {
    try {
        const response = await fetch('/api/borrowed-books');
        const books = await readResponse(response);
        borrowedBookDiv.innerHTML = '';
        if (!books.length) { borrowedBookDiv.innerHTML = '<p class="library-empty-message">No borrowed books.</p>'; return; }
        books.forEach(book => {
            const card = document.createElement('aside'); card.className = 'book-card';
            const overdue = isOverdue(book.dueAt);
            if (overdue) card.classList.add('book-card-overdue');
            card.innerHTML = `
                <p><strong>Title:</strong> ${escapeHTML(book.title)}</p>
                <p><strong>Author:</strong> ${escapeHTML(book.author)}</p>
                <p><strong>Status/Room:</strong> ${escapeHTML(book.status)}</p>
                <p class="borrowed-status"><strong>Status:</strong> ${overdue ? 'borrowed <span class="overdue-tag">OVERDUE</span>' : 'borrowed'}</p>
                <p><strong>Borrowed on:</strong> ${escapeHTML(formatDate(book.borrowedAt))}</p>
                <p><strong>Return date:</strong> ${escapeHTML(formatDate(book.dueAt))}${book.loanDays ? ` (${escapeHTML(book.loanDays)}-day loan)` : ''}</p>
                <p><strong>Borrower:</strong> ${escapeHTML(book.username)}</p>
                <p><strong>Email:</strong> ${escapeHTML(book.email)}</p>
                <button type="button" class="return-book-btn">RETURN BOOK</button>`;
            card.querySelector('.return-book-btn').addEventListener('click', async () => {
                if (!confirm(`Return “${book.title}” to the available books?`)) return;
                try {
                    const result = await readResponse(await fetch('/api/return', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(book) }));
                    await Promise.all([displayBorrowedBooks(), findBooks()]); refreshDashboard(); alert(result.message || 'Book returned.');
                } catch (error) { alert(`Could not return book: ${error.message}`); }
            });
            borrowedBookDiv.appendChild(card);
        });
    } catch (error) { borrowedBookDiv.innerHTML = `<p class="library-error-message">${escapeHTML(error.message)}</p>`; }
}

async function displayDonations() {
    try {
        const response = await fetch('/api/donations');
        const donations = await readResponse(response);
        donateBookDiv.innerHTML = '';
        if (!donations.length) { donateBookDiv.innerHTML = '<p class="library-empty-message">No donations awaiting approval.</p>'; return; }
        donations.forEach(donation => {
            const card = document.createElement('aside'); card.className = 'book-card donation-card';
            card.innerHTML = `
                <p><strong>Title:</strong> ${escapeHTML(donation.title)}</p>
                <p><strong>Author:</strong> ${escapeHTML(donation.author)}</p>
                <p><strong>Status / Room:</strong> ${escapeHTML(donation.status)}</p>
                <p><strong>Description:</strong> ${escapeHTML(donation.bookDescription)}</p>
                <p><strong>Donated by:</strong> ${escapeHTML(donation.donatedBy || 'Unknown')}</p>
                <p><strong>Submitted:</strong> ${escapeHTML(donation.donatedAt ? new Date(donation.donatedAt).toLocaleString() : 'Unknown')}</p>
                <button type="button" class="approve-donation-btn">REVIEW DONATION</button>`;
            card.querySelector('.approve-donation-btn').addEventListener('click', () => {
                selectedDonation = donation;
                document.getElementById('donation-dialog-message').textContent = `Accept “${donation.title}” by ${donation.author} into the library, or reject this donation?`;
                showDialog(donationDialog);
            });
            donateBookDiv.appendChild(card);
        });
    } catch (error) { donateBookDiv.innerHTML = `<p class="library-error-message">${escapeHTML(error.message)}</p>`; }
}
async function decideDonation(decision) {
    if (!selectedDonation) return;
    const actionText = decision === 'approve' ? 'approve' : 'reject';
    if (!confirm(`Are you sure you want to ${actionText} “${selectedDonation.title}”?`)) return;
    try {
        const response = await fetch(`/api/donations/${encodeURIComponent(selectedDonation.id)}/${decision}`, { method: 'POST' });
        const result = await readResponse(response);
        hideDialog(donationDialog);
        selectedDonation = null;
        await Promise.all([displayDonations(), findBooks()]);
        alert(result.message || `Donation ${actionText}ed.`);
    } catch (error) { alert(`Could not ${actionText} donation: ${error.message}`); }
}

patternSearchSubmit.addEventListener('click', findBooks);
patternSearchInput.addEventListener('keydown', event => { if (event.key === 'Enter') findBooks(); });
document.getElementById('add-book').addEventListener('click', addBook);
document.getElementById('dialog-yes').addEventListener('click', deleteSelectedBook);
document.getElementById('dialog-no').addEventListener('click', () => { selectedBookForDelete = null; hideDialog(confirmationDialog); });
document.getElementById('borrow-confirm').addEventListener('click', borrowSelectedBook);
document.getElementById('borrow-cancel').addEventListener('click', () => { selectedBookForBorrow = null; hideDialog(borrowDialog); });
document.getElementById('donation-approve').addEventListener('click', () => decideDonation('approve'));
document.getElementById('donation-reject').addEventListener('click', () => decideDonation('reject'));
document.getElementById('donation-cancel').addEventListener('click', () => { selectedDonation = null; hideDialog(donationDialog); });

[confirmationDialog, borrowDialog, donationDialog].forEach(dialog => { dialog.hidden = true; dialog.style.display = 'none'; });
findBooks(); displayBorrowedBooks(); displayDonations();
